import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

const digest = (value) => createHash('sha256').update(value).digest();

/** A user JWT, request-body email or query parameter can never authorize admin access. */
export function requireAdmin(req, _res, next) {
  const configuredKey = env.admin.apiKey;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(configuredKey)) {
    return next(ApiError.serviceUnavailable('Admin API is not configured'));
  }

  const header = req.headers.authorization;
  const token = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(header)?.[1] : null;
  // Compare fixed-length digests so credential length cannot throw or skip the comparison.
  const matches = timingSafeEqual(digest(token ?? ''), digest(configuredKey));
  if (!token || !matches) return next(ApiError.unauthorized('Invalid admin credentials'));
  next();
}
