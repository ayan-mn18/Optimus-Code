import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { enroll, getEnrollment, getToday, markSolved, unmarkSolved, getStreak } from '../services/challenge.service.js';

const router = Router();

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const enrollment = await getEnrollment(req.user.id);
    res.json({ enrollment, streak: enrollment ? await getStreak(req.user) : null });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/enroll',
  validate(z.object({ dailyTarget: z.number().int().min(1).max(20).optional() })),
  async (req, res, next) => {
    try {
      const enrollment = await enroll(req.user.id, {
        dailyTarget: req.body.dailyTarget,
        timezone: req.user.timezone,
      });
      res.status(201).json({ enrollment });
    } catch (err) {
      next(err);
    }
  },
);

router.get('/today', async (req, res, next) => {
  try {
    const [today, streak] = [await getToday(req.user), await getStreak(req.user)];
    res.json({ ...today, streak });
  } catch (err) {
    next(err);
  }
});

const solveSchema = z.object({
  timeSpentMin: z.number().int().min(0).max(1440).nullish(),
  notes: z.string().max(2000).nullish(),
});

router.post('/solve/:problemId', validate(solveSchema), async (req, res, next) => {
  try {
    res.json(await markSolved(req.user, req.params.problemId, req.body));
  } catch (err) {
    next(err);
  }
});

router.delete('/solve/:problemId', async (req, res, next) => {
  try {
    res.json(await unmarkSolved(req.user, req.params.problemId));
  } catch (err) {
    next(err);
  }
});

export default router;
