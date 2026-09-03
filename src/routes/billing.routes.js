import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  PRICING,
  createCheckout,
  getSubscription,
  processDodoWebhook,
  verifyDodoWebhook,
} from '../services/billing.service.js';
import { ApiError } from '../lib/errors.js';

const router = Router();

router.get('/pricing', (_req, res) => res.json({ plans: PRICING }));

router.post('/webhook', async (req, res, next) => {
  try {
    if (!req.rawBody) throw ApiError.badRequest('Webhook body is unavailable');
    const webhookId = req.headers['webhook-id'];
    if (typeof webhookId !== 'string' || !webhookId) throw ApiError.badRequest('Missing webhook ID');
    const event = verifyDodoWebhook(req.rawBody.toString('utf8'), req.headers);
    const result = await processDodoWebhook(event, webhookId);
    res.json({ received: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.use(requireAuth);

router.get('/subscription', async (req, res, next) => {
  try {
    res.json({ subscription: await getSubscription(req.user.id) });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/checkout',
  validate(z.object({ plan: z.enum(['monthly', 'annual']) })),
  async (req, res, next) => {
    try {
      res.status(201).json(await createCheckout(req.user, req.body.plan));
    } catch (error) {
      next(error);
    }
  },
);

export default router;
