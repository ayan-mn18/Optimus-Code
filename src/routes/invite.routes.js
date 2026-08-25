import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { isValidTimezone } from '../lib/dates.js';
import { acceptInvite, inspectInvite } from '../services/invite.service.js';

const router = Router();
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many invite attempts, try again later' } },
});

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invite token is malformed');
const inspectSchema = z.object({ token });
const acceptSchema = z.object({
  token,
  name: z.string().trim().min(2, 'Name is too short').max(60),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  timezone: z.string().default('UTC').refine(isValidTimezone, 'Unknown timezone'),
});

router.post('/inspect', inviteLimiter, validate(inspectSchema), async (req, res, next) => {
  try {
    res.json(await inspectInvite(req.body.token));
  } catch (err) {
    next(err);
  }
});

router.post('/accept', inviteLimiter, validate(acceptSchema), async (req, res, next) => {
  try {
    res.status(201).json({ user: await acceptInvite(req.body.token, req.body) });
  } catch (err) {
    next(err);
  }
});

export default router;
