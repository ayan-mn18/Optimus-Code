import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildLocalQuestionSet, scoreTextAnswer } from '../src/services/assessment.service.js';
import { normalizeDailyTarget, quotaComplete } from '../src/services/challenge.service.js';
import { createCodeRunner } from '../src/services/code-runner.service.js';
import { PRICING, publicSubscription } from '../src/services/billing.service.js';

const lldProblem = {
  id: 'problem-lld',
  title: 'Design Parking Lot',
  kind: 'LLD',
  topic: 'LLD Interview Problems',

  subtopic: 'Object design',
  difficulty: 'Medium',
  description: 'Design a parking lot with multiple vehicle types.',
  coding_enabled: true,
};

const hldProblem = {
  ...lldProblem,
  id: 'problem-hld',
  title: 'Design URL Shortener',
  kind: 'HLD',
  topic: 'Interview Problems',
  coding_enabled: false,
};
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

test('local Optimus generator creates ten stable HLD questions', () => {
  const first = buildLocalQuestionSet(hldProblem, 'user-a', 1, false);
  const second = buildLocalQuestionSet(hldProblem, 'user-a', 1, false);
  assert.equal(first.length, 10);
  assert.equal(new Set(first.map((question) => question.id)).size, 10);
  assert.deepEqual(first, second);
  assert.equal(first.some((question) => question.type === 'code'), false);
  assert.ok(first.every((question) => question.prompt.includes(hldProblem.title)));
});

test('LLD generator adds one validated coding question when runner exists', () => {
  const questions = buildLocalQuestionSet(lldProblem, 'user-b', 2, true);
  const coding = questions.filter((question) => question.type === 'code');
  assert.equal(questions.length, 10);
  assert.equal(coding.length, 1);
  assert.ok(coding[0].visibleTests.length > 0);
  assert.ok(coding[0].hiddenTests.length > 0);
});

test('text grading enforces reasoning length and rubric coverage', () => {
  const question = { rubric: ['availability', 'latency', 'failure'] };
  assert.equal(scoreTextAnswer(question, { text: 'Too short.' }).score, 0);
  assert.equal(
    scoreTextAnswer(question, { text: 'I prioritize availability and bound latency while describing each failure mode explicitly.' }).score,
    1,
  );
});

test('Judge0 adapter sends isolated code and returns per-test results', async () => {
  const calls = [];
  const expected = [{ name: 'smallest', passed: true, expected: 1, actual: 1 }];
  const runner = createCodeRunner({
    config: { enabled: true, baseUrl: 'https://judge.example', apiKey: 'key', apiHost: 'judge.example' },
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({
        stdout: Buffer.from(`__OPTIMUS_RESULT__${JSON.stringify(expected)}\n`).toString('base64'),
        stderr: '',
        compile_output: '',
        status: { description: 'Accepted' },
        time: '0.01',
        memory: 1024,
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await runner.run({
    source: 'function selectNext(items) { return items[0].id; }',
    tests: [{ name: 'smallest', input: [{ id: 1, available: true }], expected: 1 }],
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.results, expected);
  const request = JSON.parse(calls[0][1].body);
  const source = Buffer.from(request.source_code, 'base64').toString('utf8');
  assert.match(source, /function selectNext/);
  assert.equal(request.enable_network, false);
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
