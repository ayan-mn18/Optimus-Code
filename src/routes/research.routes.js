import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePro } from '../middleware/subscription.js';
import { validate } from '../middleware/validate.js';
import { cancelJob, createJob, getJob, listJobs } from '../services/research/job.service.js';

const router = Router();
router.use(requireAuth);
router.use(requirePro);

router.get('/status', async (_req, res) => {
  res.json({ available: env.research.enabled && env.ai.enabled });
});

// A run costs real money and publishes under the Optimus Code name.
const startLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });

const startSchema = z.object({
  topic: z.string().trim().min(4).max(160),
  goal: z.string().trim().min(20).max(600),
  audience: z.enum(['beginner', 'intermediate', 'interview', 'senior']),
  format: z.enum(['interview-guide', 'deep-dive', 'decision-guide', 'comparison']),
  questions: z.array(z.string().trim().min(8).max(240)).min(1).max(5),
  constraints: z.string().trim().max(600).optional().default(''),
});

router.post('/', startLimiter, validate(startSchema), async (req, res, next) => {
  try {
    res.status(202).json({ job: await createJob(req.user, req.body) });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await listJobs(req.user));
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ job: await getJob(req.user, req.params.id) });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    res.json({ job: await cancelJob(req.user, req.params.id) });
  } catch (error) {
    next(error);
  }
});

export default router;
