import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase.js';
import { validate } from '../middleware/validate.js';

const router = Router();

const joinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many signups from this address, try again later' } },
});

const joinSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  name: z.string().trim().min(1).max(60).optional(),
  referrer: z.string().trim().max(200).optional(),
});

/** Total signups — drives the counter on the landing page. */
async function waitlistCount() {
  const { count, error } = await db.from('waitlist').select('*', { count: 'exact', head: true });
  if (error) throw Object.assign(new Error(`count waitlist: ${error.message}`), { status: 500 });
  return count ?? 0;
}

router.get('/', async (_req, res, next) => {
  try {
    res.json({ count: await waitlistCount() });
  } catch (err) {
    next(err);
  }
});

router.post('/', joinLimiter, validate(joinSchema), async (req, res, next) => {
  try {
    const { email, name, referrer } = req.body;

    const existing = unwrap(
      await db.from('waitlist').select('id').eq('email', email).maybeSingle(),
      'check waitlist',
    );

    // Joining twice is not an error — the landing page just says "already in".
    if (existing) {
      return res.json({ joined: true, alreadyJoined: true, count: await waitlistCount() });
    }

    unwrap(
      await db.from('waitlist').insert({ email, name: name ?? null, referrer: referrer ?? null }),
      'join waitlist',
    );

    res.status(201).json({ joined: true, alreadyJoined: false, count: await waitlistCount() });
  } catch (err) {
    next(err);
  }
});

export default router;
