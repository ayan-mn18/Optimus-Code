import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAdmin } from '../middleware/admin.js';
import { validate } from '../middleware/validate.js';
import { grantComplimentaryPro } from '../services/admin.service.js';

const router = Router();

export const grantProSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email('Enter a valid email'),
}).strict();

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many admin requests, try again in a minute' } },
}));
router.use(requireAdmin);

router.post('/pro/grant', validate(grantProSchema), async (req, res, next) => {
  try {
    res.json(await grantComplimentaryPro(req.body.email));
  } catch (error) {
    next(error);
  }
});

export default router;
