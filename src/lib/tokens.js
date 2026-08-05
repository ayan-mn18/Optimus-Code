import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { db, unwrap } from './supabase.js';
import { ApiError } from './errors.js';

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessTtl,
  });
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.jwt.accessSecret);
  } catch {
    throw ApiError.unauthorized('Session expired, please sign in again');
  }
}

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Issues a refresh token and stores only its hash. */
export async function issueRefreshToken(userId) {
  const token = jwt.sign({ sub: userId, jti: crypto.randomUUID() }, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshTtl,
  });
  const { exp } = jwt.decode(token);

  unwrap(
    await db.from('refresh_tokens').insert({
      user_id: userId,
      token_hash: hash(token),
      expires_at: new Date(exp * 1000).toISOString(),
    }),
    'issue refresh token',
  );

  return token;
}

/** Verifies a refresh token, revokes it, and returns the owning user id. */
export async function rotateRefreshToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, env.jwt.refreshSecret);
  } catch {
    throw ApiError.unauthorized('Refresh token is invalid or expired');
  }

  const row = unwrap(
    await db
      .from('refresh_tokens')
      .select('id, user_id, revoked_at, expires_at')
      .eq('token_hash', hash(token))
      .maybeSingle(),
    'lookup refresh token',
  );

  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
    throw ApiError.unauthorized('Refresh token is no longer valid');
  }

  unwrap(
    await db.from('refresh_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', row.id),
    'revoke refresh token',
  );

  return payload.sub;
}

export async function revokeAllRefreshTokens(userId) {
  unwrap(
    await db
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('revoked_at', null),
    'revoke refresh tokens',
  );
}
