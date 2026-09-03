import { env } from '../config/env.js';
import nodemailer from 'nodemailer';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

export function parseSender(value) {
  const match = value.trim().match(/^(.*?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: value.trim() };
}

export function createEmailSender({ fetchImpl = fetch, apiKey, from, replyTo, endpoint = BREVO_ENDPOINT }) {
  return {
    async send({ to, message, idempotencyKey }) {
      if (!apiKey || !from) return { sent: false, reason: 'not_configured' };

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          sender: parseSender(from),
          to: [{ email: to }],
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
          ...(replyTo ? { replyTo: parseSender(replyTo) } : {}),
          headers: { 'Idempotency-Key': idempotencyKey },
          tags: ['optimus-code'],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`Brevo email failed: ${payload.message ?? response.statusText}`);
      }
      return { sent: true, messageId: payload.messageId };
    },
  };
}

export function createSmtpEmailSender({ host, port, secure, user, password, from, replyTo }) {
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass: password },
  });

  return {
    async send({ to, message, idempotencyKey }) {
      if (!user || !password || !from) return { sent: false, reason: 'not_configured' };
      const info = await transporter.sendMail({
        from,
        to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(replyTo ? { replyTo } : {}),
        headers: { 'X-Optimus-Idempotency-Key': idempotencyKey },
      });
      return { sent: true, messageId: info.messageId };
    },
    verify: () => transporter.verify(),
  };
}

export const email = env.email.transport === 'smtp'
  ? createSmtpEmailSender({
    host: env.email.smtpHost,
    port: env.email.smtpPort,
    secure: env.email.smtpSecure,
    user: env.email.smtpUser,
    password: env.email.apiKey,
    from: env.email.from,
    replyTo: env.email.replyTo,
  })
  : createEmailSender({
    apiKey: env.email.apiKey,
    from: env.email.from,
    replyTo: env.email.replyTo,
  });

export const emailConfigured = () => env.email.enabled;
