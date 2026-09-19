import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { hasProAccess } from '../middleware/subscription.js';
import { validate } from '../middleware/validate.js';
import { getSearchIndex, searchContent } from '../services/search.service.js';

const router = Router();
router.use(requireAuth);

const searchSchema = z.object({
  q: z.string().trim().min(2).max(80),
});

router.get('/', validate(searchSchema, 'query'), async (req, res, next) => {
  try {
    // DSA remains searchable for every signed-in user, while Pro-only blog
    // documents stay out of the free command-bar catalogue altogether.
    res.json(await searchContent(req.validatedQuery.q, { includeBlogs: await hasProAccess(req.user) }));
  } catch (error) {
    next(error);
  }
});

router.get('/index', async (req, res, next) => {
  try {
    // Keep the client-side index subject to the same Pro visibility boundary
    // as live command-bar search.
    res.json(await getSearchIndex({ includeBlogs: await hasProAccess(req.user) }));
  } catch (error) {
    next(error);
  }
});

export default router;
