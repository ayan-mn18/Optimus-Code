import { db, unwrap } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { email, emailConfigured } from './email.service.js';
import { billingEmail } from '../emails/templates.js';

const PAYMENT_EVENTS = new Set(['payment.succeeded', 'payment.failed']);
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.active',
  'subscription.renewed',
  'subscription.on_hold',
  'subscription.failed',
  'subscription.update_payment_method',
  'subscription.cancelled',
  'subscription.expired',
]);
const DUNNING_EVENTS = new Set(['dunning.started', 'dunning.recovered']);

function planFor(data, existing) {
  if (data?.metadata?.plan === 'annual' || existing?.plan === 'annual') return 'annual';
  return 'monthly';
}

function eventKind(eventType) {
  if (eventType === 'payment.succeeded') return 'receipt';
  if (eventType === 'payment.failed') return 'failed';
  if (eventType === 'subscription.active') return 'welcome';
  if (eventType === 'subscription.renewed' || eventType === 'dunning.recovered') return 'renewal';
  if (eventType === 'subscription.cancelled' || eventType === 'subscription.expired') return 'cancelled';
  if (SUBSCRIPTION_EVENTS.has(eventType) || eventType === 'dunning.started') return 'action';
  return null;
}

async function findRecipient(data, userId) {
  if (userId) {
    const user = unwrap(
      await db.from('users').select('id, email, name').eq('id', userId).maybeSingle(),
      'load billing email user',
    );
    if (user) return user;
  }

  const emailAddress = data?.customer?.email;
  if (!emailAddress) return null;
  return { email: emailAddress, name: data.customer.name ?? emailAddress.split('@')[0] };
}

/**
 * Sends one idempotent customer email for a signed DoDo event. DoDo remains
 * responsible for the actual invoice and retry schedule; Optimus mirrors the
 * important lifecycle events so customers have a clear, branded trail.
 */
export async function sendBillingEmailForEvent(event, eventId, { userId, existing, sender = email, enabled = emailConfigured() } = {}) {
  if (!enabled) return false;
  const kind = eventKind(event.type);
  if (!kind) return false;

  const data = event.data ?? {};
  const user = await findRecipient(data, userId ?? data.metadata?.user_id ?? null);
  if (!user?.email) return false;

  const isPayment = PAYMENT_EVENTS.has(event.type);
  const amount = isPayment
    ? data.total_amount
    : data.recurring_pre_tax_amount;
  const updatePaymentUrl = data.payment_link ?? data.payment_method_update_url ?? null;
  const message = billingEmail({
    kind,
    name: user.name,
    plan: planFor(data, existing),
    amount,
    currency: data.currency ?? 'USD',
    invoiceUrl: data.invoice_url ?? null,
    nextBillingDate: data.next_billing_date ?? existing?.current_period_end ?? null,
    loginUrl: `${env.email.appUrl}/settings`,
    updatePaymentUrl,
  });

  const result = await sender.send({
    to: user.email,
    message,
    idempotencyKey: `billing/${eventId}`,
  });
  return Boolean(result.sent);
}

export const isBillingEmailEvent = (eventType) =>
  PAYMENT_EVENTS.has(eventType) || SUBSCRIPTION_EVENTS.has(eventType) || DUNNING_EVENTS.has(eventType);
