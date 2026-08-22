import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getPendingMilestone, markMilestoneViewed, MILESTONE_STEP } from '../services/milestone.service.js';

const router = Router();

router.use(requireAuth);

router.get('/pending', async (req, res, next) => {
  try {
    res.json({ milestone: await getPendingMilestone(req.user) });
  } catch (err) {
    next(err);
  }
});

const milestoneParams = z.object({
  milestone: z.coerce
    .number()
    .int()
    .min(MILESTONE_STEP)
    .refine((value) => value % MILESTONE_STEP === 0, `Milestone must be a multiple of ${MILESTONE_STEP}`),
});

router.post('/:milestone/viewed', validate(milestoneParams, 'params'), async (req, res, next) => {
  try {
    await markMilestoneViewed(req.user.id, req.params.milestone);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
