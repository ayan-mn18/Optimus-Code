import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';
import { isValidTimezone } from '../lib/dates.js';
import { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeAllRefreshTokens } from '../lib/tokens.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getEnrollment } from '../services/challenge.service.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, try again in a few minutes' } },
});


const timezone = z
  .string()
  .default('UTC')
  .refine(isValidTimezone, { message: 'Unknown timezone' });


const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  timezone: user.timezone,
  avatarSeed: user.avatar_seed,
  showOnLeaderboard: user.show_on_leaderboard ?? true,
  createdAt: user.created_at,
});

async function sessionPayload(user) {
  const [accessToken, refreshToken, enrollment] = await Promise.all([
    signAccessToken(user),
    issueRefreshToken(user.id),
    getEnrollment(user.id),
  ]);
  return { user: publicUser(user), enrollment, accessToken, refreshToken };
}


router.post('/login', authLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = unwrap(
      await db.from('users').select('*').eq('email', email).maybeSingle(),
      'load user',
    );

    // Compare against a dummy hash when the user is missing to keep timing flat.
    const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) throw ApiError.unauthorized('Email or password is incorrect');

    res.json(await sessionPayload(user));
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', validate(z.object({ refreshToken: z.string().min(10) })), async (req, res, next) => {
  try {
    const userId = await rotateRefreshToken(req.body.refreshToken);
    const user = unwrap(await db.from('users').select('*').eq('id', userId).maybeSingle(), 'load user');
    if (!user) throw ApiError.unauthorized('Account no longer exists');

    res.json(await sessionPayload(user));
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await revokeAllRefreshTokens(req.user.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    res.json({ user: publicUser(req.user), enrollment: await getEnrollment(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/me',
  requireAuth,
  validate(
    z.object({
      name: z.string().trim().min(2).max(60).optional(),
      timezone: timezone.optional(),
      showOnLeaderboard: z.boolean().optional(),
    }),
  ),
  async (req, res, next) => {
    try {
      const patch = { updated_at: new Date().toISOString() };
      if (req.body.name) patch.name = req.body.name;
      if (req.body.timezone) patch.timezone = req.body.timezone;
      if (req.body.showOnLeaderboard !== undefined) patch.show_on_leaderboard = req.body.showOnLeaderboard;

      const user = unwrap(
        await db.from('users').update(patch).eq('id', req.user.id).select('*').single(),
        'update profile',
      );
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
