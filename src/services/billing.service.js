import DodoPayments from 'dodopayments';
import { env } from '../config/env.js';
import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';

export const PRICING = {
  monthly: { amount: 10, currency: 'USD', interval: 'month' },
  annual: { amount: 80, currency: 'USD', interval: 'year' },
};

const STATUS_BY_EVENT = {
  'subscription.active': 'active',
  'subscription.updated': null,
  'subscription.on_hold': 'on_hold',
  'subscription.paused': 'paused',
  'subscription.unpaused': 'active',
  'subscription.renewed': 'active',
  'subscription.plan_changed': null,
  'subscription.update_payment_method': null,
  'subscription.cancelled': 'cancelled',
  'subscription.failed': 'failed',
  'subscription.expired': 'expired',
};

const dodo = env.billing.enabled
  ? new DodoPayments({
      bearerToken: env.billing.apiKey,
      environment: env.billing.environment,
      webhookKey: env.billing.webhookKey || undefined,
    })
  : null;

export function publicSubscription(row) {
  if (!row) return null;
  return {
    plan: row.plan,
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

export async function getSubscription(userId) {
  const row = unwrap(
    await db.from('subscriptions').select('*').eq('user_id', userId).maybeSingle(),
    'load subscription',
  );
  return publicSubscription(row);
}

export async function createCheckout(user, plan, { client = dodo } = {}) {
  if (!client) throw new ApiError(503, 'Billing is not configured');
  const productId = plan === 'monthly' ? env.billing.monthlyProductId : env.billing.annualProductId;
  if (!productId) throw new ApiError(503, `${plan} billing product is not configured`);

  const session = await client.checkoutSessions.create({
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { email: user.email, name: user.name },
    return_url: `${env.email.appUrl}/billing/success`,
    metadata: { user_id: user.id, plan },
  });
  if (!session.checkout_url) throw new ApiError(502, 'Dodo did not return a checkout URL');

  unwrap(
    await db.from('subscriptions').upsert(
      {
        user_id: user.id,
        provider: 'dodo',
        plan,
        status: 'pending',
        checkout_session_id: session.session_id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    ),
    'record pending checkout',
  );
  return { checkoutUrl: session.checkout_url };
}

export function verifyDodoWebhook(rawBody, headers, { client = dodo } = {}) {
  if (!client || !env.billing.webhookKey) throw new ApiError(503, 'Billing webhook is not configured');
  try {
    return client.webhooks.unwrap(rawBody, {
      headers: {
        'webhook-id': headers['webhook-id'],
        'webhook-signature': headers['webhook-signature'],
        'webhook-timestamp': headers['webhook-timestamp'],
      },
    });
  } catch {
    throw ApiError.unauthorized('Invalid Dodo webhook signature');
  }
}

export async function processDodoWebhook(event, webhookId) {
  const inserted = await db.from('payment_webhook_events').insert({
    id: webhookId,
    event_type: event.type,
    payload: event,
  });
  if (inserted.error?.code === '23505') return { duplicate: true };
  if (inserted.error) throw Object.assign(new Error(`record billing webhook: ${inserted.error.message}`), { status: 500 });

  try {
    if (!event.type?.startsWith('subscription.')) return { duplicate: false, handled: false };
    const data = event.data ?? {};
    let userId = data.metadata?.user_id ?? null;
    let existing = null;
    if (!userId && data.subscription_id) {
      existing = unwrap(
        await db.from('subscriptions').select('*').eq('provider_subscription_id', data.subscription_id).maybeSingle(),
        'find webhook subscription',
      );
      userId = existing?.user_id ?? null;
    }
    if (!userId) return { duplicate: false, handled: false };

    const explicitStatus = STATUS_BY_EVENT[event.type];
    const allowedStatus = ['pending', 'active', 'on_hold', 'paused', 'cancelled', 'failed', 'expired'];
    const status = explicitStatus ?? (allowedStatus.includes(data.status) ? data.status : existing?.status ?? 'pending');
    const plan = data.metadata?.plan ?? existing?.plan;
    if (!['monthly', 'annual'].includes(plan)) throw ApiError.badRequest('Webhook is missing a valid plan');

    unwrap(
      await db.from('subscriptions').upsert(
        {
          user_id: userId,
          provider: 'dodo',
          plan,
          status,
          provider_customer_id: data.customer?.customer_id ?? data.customer_id ?? existing?.provider_customer_id ?? null,
          provider_subscription_id: data.subscription_id ?? existing?.provider_subscription_id ?? null,
          current_period_end: data.next_billing_date ?? data.expires_at ?? existing?.current_period_end ?? null,
          cancel_at_period_end: Boolean(data.cancel_at_next_billing_date ?? data.cancel_at_period_end),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      ),
      'sync subscription webhook',
    );
    return { duplicate: false, handled: true };
  } catch (error) {
    await db.from('payment_webhook_events').delete().eq('id', webhookId);
    throw error;
  }
}
