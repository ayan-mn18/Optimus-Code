import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getOverview, listProblems, listTopics } from '../services/stats.service.js';
import { getWeeklyRecap } from '../services/recap.service.js';

const router = Router();

router.use(requireAuth);

router.get('/overview', async (req, res, next) => {
  try {
    res.json(await getOverview(req.user));
  } catch (err) {
    next(err);
  }
});

const recapSchema = z.object({
  weeksAgo: z.coerce.number().int().min(0).max(52).default(0),
});

router.get('/recap', validate(recapSchema, 'query'), async (req, res, next) => {
  try {
    res.json(await getWeeklyRecap(req.user, req.validatedQuery));
  } catch (err) {
    next(err);
  }
});

const listSchema = z.object({
  topic: z.string().optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']).optional(),
  status: z.enum(['solved', 'unsolved', 'all']).optional(),
  search: z.string().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(200),
});

router.get('/problems', validate(listSchema, 'query'), async (req, res, next) => {
  try {
    res.json(await listProblems(req.user, req.validatedQuery));
  } catch (err) {
    next(err);
  }
});

router.get('/topics', async (_req, res, next) => {
  try {
    res.json({ topics: await listTopics() });
  } catch (err) {
    next(err);
  }
});

export default router;
