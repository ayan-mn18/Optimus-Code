import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { email, emailConfigured } from '../services/email.service.js';

const router = Router();
const supportEmail = process.env.SUPPORT_EMAIL?.trim() || 'info@optimusco.de';
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many reports from this account, try again later' } },
});

const screenshotSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  dataUrl: z.string()
    .max(7_000_000, 'Screenshot is too large')
    .regex(/^data:image\/(?:png|jpeg|webp);base64,/, 'Screenshot must be a PNG, JPEG, or WebP image'),
});

const reportSchema = z.object({
  message: z.string().trim().min(10, 'Tell us a little more about the problem').max(5_000),
  steps: z.string().trim().max(2_000).optional(),
  pageUrl: z.string().trim().url().max(500).optional(),
  userAgent: z.string().trim().max(500).optional(),
  screenshot: screenshotSchema.optional(),
});

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function block(label, value) {
  if (!value) return '';
  return `<div style="margin-top:18px"><p style="margin:0 0 6px;color:#c4b5fd;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase">${escapeHtml(label)}</p><pre style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:#f2f2f7;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(value)}</pre></div>`;
}

router.use(requireAuth);

router.post('/', reportLimiter, validate(reportSchema), async (req, res, next) => {
  try {
    if (!emailConfigured()) throw ApiError.serviceUnavailable('Problem reports are temporarily unavailable');

    const { message, steps, pageUrl, userAgent, screenshot } = req.body;
    const reportId = randomUUID();
    const reporter = `${req.user.name || 'Optimus user'} <${req.user.email}>`;
    const text = [
      'A problem was reported from Optimus Code.',
      `Reporter: ${reporter}`,
      `Page: ${pageUrl || 'Not provided'}`,
      '',
      'What happened:',
      message,
      steps ? `\nSteps to reproduce:\n${steps}` : '',
      userAgent ? `\nBrowser/device:\n${userAgent}` : '',
      screenshot ? `\nScreenshot attached: ${screenshot.name}` : '',
      `\nReport ID: ${reportId}`,
    ].filter(Boolean).join('\n');
    const html = [
      '<p style="margin:0;color:#a1a1b0;font-size:15px;line-height:1.65">A problem was reported from Optimus Code.</p>',
      block('Reporter', reporter),
      block('Page', pageUrl || 'Not provided'),
      block('What happened', message),
      block('Steps to reproduce', steps),
      block('Browser/device', userAgent),
      block('Report ID', reportId),
    ].join('');

    const attachments = screenshot ? [{
      filename: screenshot.name,
      content: screenshot.dataUrl.slice(screenshot.dataUrl.indexOf(',') + 1),
      contentType: screenshot.type,
    }] : [];

    await email.send({
      to: supportEmail,
      message: {
        subject: 'New Optimus Code problem report',
        html,
        text,
      },
      attachments,
      idempotencyKey: `problem-report/${req.user.id}/${reportId}`,
    });

    res.status(202).json({ sent: true });
  } catch (err) {
    next(err);
  }
});

export default router;
