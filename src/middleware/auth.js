import { db, unwrap } from '../lib/supabase.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { ApiError } from '../lib/errors.js';
import { getOrSetCached } from '../lib/cache.js';

const SESSION_USER_TTL_MS = 5_000;
const ACTIVITY_WRITE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const activityWrites = new Map();

function loadSessionUser(userId) {
  return getOrSetCached(`auth:user:${userId}`, SESSION_USER_TTL_MS, async () => unwrap(
    await db
      .from('users')
      .select('id, email, name, timezone, avatar_seed, picture_url, auth_provider, billing_exempt, show_on_leaderboard, created_at')
      .eq('id', userId)
      .maybeSingle(),
    'load session user',
  ));
}

async function touchActivity(userId) {
  const now = Date.now();
  const previous = activityWrites.get(userId);
  if (previous && now - previous < ACTIVITY_WRITE_INTERVAL_MS) return;
  activityWrites.set(userId, now);
  try {
    const { error } = await db
      .from('users')
      .update({ last_activity_at: new Date(now).toISOString() })
      .eq('id', userId);
    if (error) throw error;
  } catch (error) {
    activityWrites.delete(userId);
    console.error('[auth] activity timestamp failed:', error instanceof Error ? error.message : error);
  }
}

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw ApiError.unauthorized('Missing bearer token');
    }

    const payload = verifyAccessToken(token);
    const user = await loadSessionUser(payload.sub);

    if (!user) throw ApiError.unauthorized('Account no longer exists');

    req.user = user;
    await touchActivity(user.id);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Populates `req.user` when a valid bearer token is present and moves on
 * otherwise. Used by routes that are readable by anyone but render extra state
 * (own drafts, like state) for a signed-in reader.
 */
export async function optionalAuth(req, _res, next) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) return next();

  try {
    const payload = verifyAccessToken(token);
    req.user = await loadSessionUser(payload.sub) ?? undefined;
  } catch {
    // An expired or malformed token reads as an anonymous visitor here.
  }
  next();
}
