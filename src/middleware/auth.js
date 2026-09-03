import { db, unwrap } from '../lib/supabase.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { ApiError } from '../lib/errors.js';

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw ApiError.unauthorized('Missing bearer token');
    }

    const payload = verifyAccessToken(token);
    const user = unwrap(
      await db
        .from('users')
        .select('id, email, name, timezone, avatar_seed, picture_url, auth_provider, show_on_leaderboard, created_at')
        .eq('id', payload.sub)
        .maybeSingle(),
      'load session user',
    );

    if (!user) throw ApiError.unauthorized('Account no longer exists');

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
