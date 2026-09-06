import { env } from '../config/env.js';
import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';

// Kept as a small shared check so catalogue search can hide Pro-only blog
// results without turning the entire DSA search experience into a paid route.
export async function getProAccess(user) {
  if (user.billing_exempt || !env.billing.enabled) return { allowed: true, subscription: null };
  const subscription = unwrap(
    await db.from('subscriptions').select('status, current_period_end').eq('user_id', user.id).maybeSingle(),
    'load subscription access',
  );
  const periodValid = !subscription?.current_period_end || new Date(subscription.current_period_end) > new Date();
  return { allowed: Boolean(subscription && subscription.status === 'active' && periodValid), subscription };
}

export async function hasProAccess(user) {
  return (await getProAccess(user)).allowed;
}

export async function requirePro(req, _res, next) {
  try {
    const access = await getProAccess(req.user);
    if (!access.allowed) {
      throw new ApiError(402, 'Optimus Pro is required for this content');
    }
    req.subscription = access.subscription;
    next();
  } catch (error) {
    next(error);
  }
}
