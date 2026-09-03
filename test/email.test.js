import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailSender, parseSender } from '../src/services/email.service.js';
import { hashInviteToken } from '../src/services/invite.service.js';
import {
  accountReadyEmail,
  inviteEmail,
  milestoneEmail,
  redDayEmail,
  streakRiskEmail,
} from '../src/emails/templates.js';

test('email sender passes content and idempotency to Brevo', async () => {
  const calls = [];
  const sender = createEmailSender({
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({ messageId: 'email-123' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    },
    apiKey: 'brevo-test-key',
    from: 'Optimus Code <invite@example.com>',
    replyTo: 'help@example.com',
  });
  const message = inviteEmail({ name: 'Ada', inviteUrl: 'https://example.com/invite#token=abc', expiresHours: 168 });

  const result = await sender.send({ to: 'ada@example.com', message, idempotencyKey: 'invite/123' });

  assert.deepEqual(result, { sent: true, messageId: 'email-123' });
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  const payload = JSON.parse(init.body);
  assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(init.headers['api-key'], 'brevo-test-key');
  assert.deepEqual(payload.sender, { name: 'Optimus Code', email: 'invite@example.com' });
  assert.equal(payload.to[0].email, 'ada@example.com');
  assert.equal(payload.replyTo.email, 'help@example.com');
  assert.equal(payload.headers['Idempotency-Key'], 'invite/123');
});

test('sender parser supports named and plain addresses', () => {
  assert.deepEqual(parseSender('Optimus Code <hello@example.com>'), { name: 'Optimus Code', email: 'hello@example.com' });
  assert.deepEqual(parseSender('hello@example.com'), { email: 'hello@example.com' });
});

test('disabled email sender performs no network call', async () => {
  const sender = createEmailSender({ apiKey: '', from: '', replyTo: undefined });
  const result = await sender.send({
    to: 'ada@example.com',
    message: { subject: 'No-op', html: '<p>No-op</p>', text: 'No-op' },
    idempotencyKey: 'noop/1',
  });
  assert.deepEqual(result, { sent: false, reason: 'not_configured' });
});

test('invite tokens are stored only as deterministic hashes', () => {
  const token = 'a'.repeat(43);
  const hash = hashInviteToken(token);
  assert.equal(hash.length, 64);
  assert.equal(hash, hashInviteToken(token));
  assert.equal(hash.includes(token), false);
});

test('transactional templates include plain text and escape names', () => {
  const messages = [
    inviteEmail({ name: '<script>Ada</script>', inviteUrl: 'https://example.com/invite#token=abc', expiresHours: 168 }),
    accountReadyEmail({ name: 'Ada', loginUrl: 'https://example.com/login' }),
    milestoneEmail({
      name: 'Ada',
      milestone: 100,
      headline: 'Strong work.',
      topTopics: [{ topic: 'Graphs', count: 20 }],
      nextMilestone: 150,
      appUrl: 'https://example.com',
    }),
    redDayEmail({ name: 'Ada', date: '2026-08-24', solved: 2, required: 5, loginUrl: 'https://example.com' }),
    streakRiskEmail({ name: 'Ada', remaining: 2, currentStreak: 9, hoursLeft: 4, loginUrl: 'https://example.com' }),
  ];

  for (const message of messages) {
    assert.ok(message.subject.length > 5);
    assert.match(message.html, /Optimus Code/);
    assert.ok(message.text.length > 20);
    assert.doesNotMatch(message.html, /undefined/);
  }
  assert.doesNotMatch(messages[0].html, /<script>Ada<\/script>/);
  assert.match(messages[0].html, /&lt;script&gt;Ada&lt;\/script&gt;/);
});
