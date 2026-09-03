import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requirePro } from '../middleware/subscription.js';
import { validate } from '../middleware/validate.js';
import {
  createAssessment,
  getAssessment,
  saveAssessmentAnswer,
  submitAssessment,
} from '../services/assessment.service.js';

const router = Router();
router.use(requireAuth);
router.use(requirePro);

const generationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Assessment limit reached. Try again later.' } },
});

router.post(
  '/',
  generationLimiter,
  validate(z.object({ problemId: z.string().uuid() })),
  async (req, res, next) => {
    try {
      res.status(201).json(await createAssessment(req.user, req.body.problemId));
    } catch (error) {
      next(error);
    }
  },
);

router.get('/:attemptId', async (req, res, next) => {
  try {
    res.json(await getAssessment(req.user, req.params.attemptId));
  } catch (error) {
    next(error);
  }
});

const answerSchema = z.object({
  answer: z.object({ values: z.array(z.string().max(240)).max(6) }),
});

router.patch('/:attemptId/answers/:questionId', validate(answerSchema), async (req, res, next) => {
  try {
    res.json({ answer: await saveAssessmentAnswer(req.user, req.params.attemptId, req.params.questionId, req.body.answer) });
  } catch (error) {
    next(error);
  }
});

router.post('/:attemptId/submit', async (req, res, next) => {
  try {
    res.json(await submitAssessment(req.user, req.params.attemptId));
  } catch (error) {
    next(error);
  }
});

export default router;
