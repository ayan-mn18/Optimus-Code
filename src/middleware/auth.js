import { db, unwrap } from '../lib/supabase.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { ApiError } from '../lib/errors.js';
import { getOrSetCached } from '../lib/cache.js';

const SESSION_USER_TTL_MS = 5_000;

function loadSessionUser(userId) {
  return getOrSetCached(`auth:user:${userId}`, SESSION_USER_TTL_MS, async () => unwrap(
    await db
      .from('users')
      .select('id, email, name, timezone, avatar_seed, picture_url, auth_provider, show_on_leaderboard, created_at')
      .eq('id', userId)
      .maybeSingle(),
    'load session user',
  ));
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
