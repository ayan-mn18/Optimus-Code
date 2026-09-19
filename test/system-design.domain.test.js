import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalizeDailyTarget, quotaComplete } from '../src/services/challenge.service.js';
import { createJudge0 } from '../src/services/runner/judge0.js';
import { PRICING, publicSubscription } from '../src/services/billing.service.js';

test('daily picker rejects object targets instead of expanding to full catalog', () => {
  assert.equal(normalizeDailyTarget(3, 'DSA'), 3);
  assert.throws(() => normalizeDailyTarget({ DSA: 3 }, 'DSA'), /Invalid DSA daily target/);
  assert.throws(() => normalizeDailyTarget(21, 'DSA'), /Invalid DSA daily target/);
});

test('daily completion requires every configured category', () => {
  assert.equal(quotaComplete({ dsa_required: 3, dsa_solved: 3, lld_required: 1, lld_solved: 1, hld_required: 1, hld_solved: 1 }), true);
  assert.equal(quotaComplete({ dsa_required: 3, dsa_solved: 5, lld_required: 1, lld_solved: 0, hld_required: 1, hld_solved: 2 }), false);
  assert.equal(quotaComplete({ dsa_required: 0, dsa_solved: 0, lld_required: 1, lld_solved: 1, hld_required: 0, hld_solved: 0 }), true);
});

test('Judge0 transport encodes the program, forbids the network, and dedupes repeats', async () => {
  const calls = [];
  const transport = createJudge0({
    config: { enabled: true, baseUrl: 'https://judge.example', apiKey: 'key', apiHost: 'judge.example', concurrency: 2 },
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({
        stdout: Buffer.from('hello\n').toString('base64'),
        stderr: '',
        compile_output: '',
        status: { description: 'Accepted' },
        time: '0.01',
        memory: 1024,
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });

  const source_code = `print("hello")  # ${Math.random()}`;
  const result = await transport.execute({ language_id: 100, source_code });
  assert.equal(result.stdout, 'hello\n');
  assert.equal(result.status.description, 'Accepted');

  const request = JSON.parse(calls[0][1].body);
  assert.equal(Buffer.from(request.source_code, 'base64').toString('utf8'), source_code);
  assert.equal(request.enable_network, false);
  assert.equal(request.cpu_time_limit, 5);
  assert.equal(calls[0][1].headers['x-rapidapi-key'], 'key');

  // Students press Run far more often than they edit; an identical body is free.
  await transport.execute({ language_id: 100, source_code });
  assert.equal(calls.length, 1);
});

test('catalog snapshot contains complete source counts and stable keys', async () => {
  const rows = JSON.parse(await fs.readFile(new URL('../data/system-design.json', import.meta.url), 'utf8'));
  assert.equal(rows.filter((row) => row.kind === 'LLD').length, 73);
  assert.equal(rows.filter((row) => row.kind === 'HLD').length, 205);
  assert.equal(new Set(rows.map((row) => `${row.kind}:${row.slug}`)).size, 278);
  assert.ok(rows.every((row) => row.source_url.startsWith('https://codewitharyan.com/questions/')));
  assert.ok(rows.every((row) => row.assessment_enabled));
});

test('pricing and subscription projection match product contract', () => {
  assert.deepEqual(PRICING.monthly, { amount: 10, currency: 'USD', interval: 'month' });
  assert.deepEqual(PRICING.annual, { amount: 80, currency: 'USD', interval: 'year' });
  assert.deepEqual(publicSubscription({
    plan: 'annual',
    status: 'active',
    current_period_end: '2027-01-01T00:00:00.000Z',
    cancel_at_period_end: false,
    provider_customer_id: 'hidden',
  }), {
    plan: 'annual',
    status: 'active',
    currentPeriodEnd: '2027-01-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
  });
});
