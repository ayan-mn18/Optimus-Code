import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getLeaderboard } from '../services/leaderboard.service.js';

const router = Router();

router.use(requireAuth);

const querySchema = z.object({
  metric: z.enum(['streak', 'solved', 'consistency']).default('streak'),
});

router.get('/', validate(querySchema, 'query'), async (req, res, next) => {
  try {
    res.json(await getLeaderboard(req.user, req.validatedQuery));
  } catch (err) {
    next(err);
  }
});

export default router;
