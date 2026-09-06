import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { searchContent } from '../services/search.service.js';

const router = Router();
router.use(requireAuth);

const searchSchema = z.object({
  q: z.string().trim().min(2).max(80),
});

router.get('/', validate(searchSchema, 'query'), async (req, res, next) => {
  try {
    res.json(await searchContent(req.validatedQuery.q));
  } catch (error) {
    next(error);
  }
});

export default router;
