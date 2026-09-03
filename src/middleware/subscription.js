import { env } from '../config/env.js';
import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';

export async function requirePro(req, _res, next) {
  try {
    if (!env.billing.enabled) {
      next();
      return;
    }
    const subscription = unwrap(
      await db.from('subscriptions').select('status, current_period_end').eq('user_id', req.user.id).maybeSingle(),
      'load subscription access',
    );
    const periodValid = !subscription?.current_period_end || new Date(subscription.current_period_end) > new Date();
    if (!subscription || subscription.status !== 'active' || !periodValid) {
      throw new ApiError(402, 'Optimus Pro is required for System Design assessments');
    }
    req.subscription = subscription;
    next();
  } catch (error) {
    next(error);
  }
}
