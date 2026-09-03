import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getSystemDesignProblem, listSystemDesign } from '../services/system-design.service.js';

const router = Router();
router.use(requireAuth);

const listSchema = z.object({
  kind: z.enum(['LLD', 'HLD']).default('LLD'),
  topic: z.string().trim().min(1).max(120).optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']).optional(),
  status: z.enum(['all', 'solved', 'unsolved']).default('all'),
  search: z.string().trim().max(120).optional(),
});

router.get('/', validate(listSchema, 'query'), async (req, res, next) => {
  try {
    res.json(await listSystemDesign(req.user, req.validatedQuery));
  } catch (error) {
    next(error);
  }
});

router.get('/:problemId', async (req, res, next) => {
  try {
    res.json({ problem: await getSystemDesignProblem(req.user, req.params.problemId) });
  } catch (error) {
    next(error);
  }
});

export default router;
