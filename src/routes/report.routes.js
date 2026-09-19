import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { reportSchema } from '../lib/report-validation.js';
import { ApiError } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { email, emailConfigured } from '../services/email.service.js';

const router = Router();
const supportEmail = process.env.SUPPORT_EMAIL?.trim() || 'info@optimusco.de';
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many reports from this address, try again later' } },
});
const accountReportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many reports from this account, try again later' } },
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
  return `<div style="margin-top:16px;padding:12px 14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px"><p style="margin:0 0 6px;color:#5b21b6;font-size:11px;font-weight:700;letter-spacing:1px;line-height:1.4;text-transform:uppercase">${escapeHtml(label)}</p><pre style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:#1f2937;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(value)}</pre></div>`;
}

router.use(requireAuth);

router.post('/', reportLimiter, accountReportLimiter, validate(reportSchema), async (req, res, next) => {
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
      '<div style="max-width:720px;margin:0 auto;background:#ffffff;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif">',
      '<div style="padding:20px 22px;background:#4338ca;border-radius:12px 12px 0 0">',
      '<p style="margin:0 0 5px;color:#c7d2fe;font-size:11px;font-weight:700;letter-spacing:1.5px;line-height:1.4;text-transform:uppercase">Optimus Code</p>',
      '<h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;line-height:1.3">New problem report</h1>',
      '</div>',
      '<div style="padding:20px 22px;background:#f8fafc;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 12px 12px">',
      '<p style="margin:0;color:#334155;font-size:15px;line-height:1.65">A problem was reported from Optimus Code.</p>',
      block('Reporter', reporter),
      block('Page', pageUrl || 'Not provided'),
      block('What happened', message),
      block('Steps to reproduce', steps),
      block('Browser/device', userAgent),
      block('Report ID', reportId),
      '</div></div>',
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
