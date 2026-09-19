import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requirePro } from '../middleware/subscription.js';
import { validate } from '../middleware/validate.js';
import { CODE_LANGUAGES, languageChoices } from '../services/runner/index.js';
import {
  createAssessment,
  abandonAssessment,
  getAssessment,
  runAssessmentAnswer,
  saveAssessmentAnswer,
  submitAssessment,
  subscribeAssessment,
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

// Runs go to a shared judge, so they are capped per user as well as per attempt.
const runLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip,
  message: { error: { message: 'Too many runs in a row. Give it a minute.' } },
});

router.get('/languages', (_req, res) => {
  res.json({ languages: languageChoices() });
});

router.post(
  '/',
  generationLimiter,
  validate(z.object({
    problemId: z.string().uuid(),
    language: z.enum(CODE_LANGUAGES).optional(),
  })),
  async (req, res, next) => {
    try {
      const result = await createAssessment(req.user, req.body.problemId, { language: req.body.language });
      res.status(result.attempt.status === 'generating' ? 202 : 201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * One authenticated stream replaces the 1.5s polling loop while a paper is
 * being prepared. The browser still receives only redacted, verified snapshots
 * from getAssessment; answer keys never enter this channel.
 */
router.get('/:attemptId/events', async (req, res, next) => {
  let unsubscribe = () => {};
  let heartbeat;
  let closed = false;
  try {
    res.status(200).set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    const send = (snapshot) => {
      if (closed || res.writableEnded) return;
      res.write(`event: assessment\ndata: ${JSON.stringify(snapshot)}\n\n`);
      res.flush?.();
    };

    // Hold events until the initial snapshot has been written so a concurrent
    // publish cannot make the client briefly move backwards to stale state.
    let ready = false;
    let pending;
    unsubscribe = subscribeAssessment(req.params.attemptId, (snapshot) => {
      if (!ready) pending = snapshot;
      else send(snapshot);
    });

    const initial = await getAssessment(req.user, req.params.attemptId);
    send(initial);
    ready = true;
    if (pending) send(pending);
    heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) {
        res.write(': keep-alive\n\n');
        res.flush?.();
      }
    }, 15_000);
    heartbeat.unref?.();

    req.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (error) {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.headersSent) next(error);
    else res.end();
  }
});

router.get('/:attemptId', async (req, res, next) => {
  try {
    res.json(await getAssessment(req.user, req.params.attemptId));
  } catch (error) {
    next(error);
  }
});

router.delete('/:attemptId', async (req, res, next) => {
  try {
    res.json(await abandonAssessment(req.user, req.params.attemptId));
  } catch (error) {
    next(error);
  }
});

/** One shape per question type: options for an MCQ, source for anything executed. */
const answerSchema = z.object({
  answer: z.union([
    z.object({ values: z.array(z.string().max(600)).max(6) }),
    z.object({
      language: z.enum([...CODE_LANGUAGES, 'sql']).optional(),
      source: z.string().max(50_000),
    }),
  ]),
});

router.patch('/:attemptId/answers/:questionId', validate(answerSchema), async (req, res, next) => {
  try {
    res.json({ answer: await saveAssessmentAnswer(req.user, req.params.attemptId, req.params.questionId, req.body.answer) });
  } catch (error) {
    next(error);
  }
});

router.post('/:attemptId/answers/:questionId/run', runLimiter, validate(answerSchema), async (req, res, next) => {
  try {
    res.json(await runAssessmentAnswer(req.user, req.params.attemptId, req.params.questionId, req.body.answer));
  } catch (error) {
    next(error);
  }
});

router.post('/:attemptId/submit', async (req, res, next) => {
  try {
    const result = await submitAssessment(req.user, req.params.attemptId);
    // A runner outage leaves the paper in grading rather than failing the student.
    res.status(result.pending ? 202 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
