import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { cancelJob, createJob, getJob, listJobs } from '../services/research/job.service.js';

const router = Router();
router.use(requireAuth);

// A run costs real money and publishes under the Optimus Code name.
const startLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });

const startSchema = z.object({
  request: z.string().trim().min(8).max(300),
});

router.post('/', startLimiter, validate(startSchema), async (req, res, next) => {
  try {
    res.status(202).json({ job: await createJob(req.user, req.body.request) });
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
