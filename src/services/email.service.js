import { Resend } from 'resend';
import { env } from '../config/env.js';

export function createEmailSender({ client, from, replyTo }) {
  return {
    async send({ to, message, idempotencyKey }) {
      if (!client || !from) return { sent: false, reason: 'not_configured' };

      const { data, error } = await client.emails.send(
        {
          from,
          to: [to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(replyTo ? { replyTo } : {}),
        },
        { idempotencyKey },
      );

      if (error) throw new Error(`Resend email failed: ${error.message}`);
      return { sent: true, messageId: data.id };
    },
  };
}

const resend = env.email.enabled ? new Resend(env.email.apiKey) : null;

export const email = createEmailSender({
  client: resend,
  from: env.email.from,
  replyTo: env.email.replyTo,
});

export const emailConfigured = () => env.email.enabled;
