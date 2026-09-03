import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { env } from '../src/config/env.js';
import { generateQuestionSet, scoreMultipleChoice } from '../src/services/assessment.service.js';
import { normalizeDailyTarget, quotaComplete } from '../src/services/challenge.service.js';
import { createCodeRunner } from '../src/services/code-runner.service.js';
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

test('MCQ grading requires an exact single- or multi-select match', () => {
  const question = { correctAnswers: ['availability', 'latency'] };
  assert.equal(scoreMultipleChoice(question, { values: ['availability', 'latency'] }).score, 1);
  assert.equal(scoreMultipleChoice(question, { values: ['latency', 'availability'] }).score, 1);
  assert.equal(scoreMultipleChoice(question, { values: ['availability'] }).score, 0);
  assert.equal(scoreMultipleChoice(question, { values: ['availability', 'latency', 'failure'] }).score, 0);
});

test('LLM generator validates ten MCQs and preserves the answer key', async () => {
  const previous = { ...env.ai };
  Object.assign(env.ai, { enabled: true, provider: 'openai', apiKey: 'test-key', baseUrl: 'https://llm.example/v1', model: 'test-model' });
  const problem = { id: 'problem-hld', title: 'Design URL Shortener', kind: 'HLD', topic: 'Distributed systems', difficulty: 'Medium' };
  const questions = Array.from({ length: 10 }, (_, index) => ({
    id: `q${index + 1}`,
    type: 'multiple_choice',
    label: `Question ${index + 1}`,
    prompt: `Choose the best design for question ${index + 1}.`,
    context: 'System design context.',
    selectionMode: index === 1 ? 'multiple' : 'single',
    options: ['A', 'B', 'C'],
    correctAnswers: index === 1 ? ['A', 'B'] : ['A'],
  }));
  const calls = [];
  try {
    const result = await generateQuestionSet(problem, 'user-a', 1, {
      fetchImpl: async (...args) => {
        calls.push(args);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions }) } }] }), { status: 200 });
      },
    });
    assert.equal(result.questions.length, 10);
    assert.ok(result.questions.every((question) => question.type === 'multiple_choice'));
    assert.deepEqual(result.questions[1].correctAnswers, ['A', 'B']);
    assert.match(calls[0][0], /chat\/completions$/);
  } finally {
    Object.assign(env.ai, previous);
  }
});

test('Optimus generation is unavailable when no LLM key is configured', async () => {
  const previous = env.ai.enabled;
  env.ai.enabled = false;
  try {
    await assert.rejects(
      generateQuestionSet({ id: 'problem', title: 'Topic', kind: 'HLD' }, 'user-a', 1),
      (error) => error?.status === 503,
    );
  } finally {
    env.ai.enabled = previous;
  }
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
