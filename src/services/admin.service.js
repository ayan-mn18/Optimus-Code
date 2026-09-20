import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';
import { invalidateCache } from '../lib/cache.js';

const USER_FIELDS = 'id, email, name, billing_exempt';
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(['cancelled', 'failed', 'expired']);

function grantResult(user, alreadyGranted) {
  // Other API processes refresh their session-user caches within five seconds.
  invalidateCache(`auth:user:${user.id}`);
  invalidateCache(`subscription:${user.id}`);
  return {
    user: { id: user.id, email: user.email, name: user.name, billingExempt: true },
    access: 'pro',
    expiresAt: null,
    alreadyGranted,
    billingUnchanged: true,
  };
}

/** Grants existing accounts permanent access; never creates a user or changes Dodo billing. */
export async function grantComplimentaryPro(email) {
  const user = unwrap(
    await db.from('users').select(USER_FIELDS).eq('email', email).maybeSingle(),
    'find complimentary Pro recipient',
  );
  if (!user) throw ApiError.notFound('No account exists for this email. Ask the recipient to sign in first.');
  if (user.billing_exempt) return grantResult(user, true);

  const subscription = unwrap(
    await db.from('subscriptions').select('status').eq('user_id', user.id).maybeSingle(),
    'check existing billing before Pro grant',
  );
  // An open checkout, paused or on-hold plan may still collect payment. Do not
  // turn off the user's billing controls while one is unresolved.
  if (subscription && !TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    throw ApiError.conflict(
      'Resolve the existing Dodo subscription or pending checkout before granting complimentary Pro. No billing was changed.',
      { subscriptionStatus: subscription.status },
    );
  }

  const updated = unwrap(
    await db.from('users')
      .update({ billing_exempt: true, updated_at: new Date().toISOString() })
      .eq('id', user.id)
      .eq('email', email)
      .eq('billing_exempt', false)
      .select(USER_FIELDS)
      .maybeSingle(),
    'grant complimentary Pro',
  );

  if (!updated) {
    // Concurrent identical grants are successful, but a changed/deleted email
    // must never accidentally upgrade a different account.
    const current = unwrap(
      await db.from('users').select(USER_FIELDS).eq('id', user.id).eq('email', email).maybeSingle(),
      'verify concurrent Pro grant',
    );
    if (current?.billing_exempt) return grantResult(current, true);
    throw ApiError.conflict('The account changed during the grant. Check the email and retry.');
  }

  // Deliberately omit the credential, email address and request body from logs.
  console.info('[admin]', JSON.stringify({ action: 'pro.granted', userId: updated.id, at: new Date().toISOString() }));
  return grantResult(updated, false);
}
