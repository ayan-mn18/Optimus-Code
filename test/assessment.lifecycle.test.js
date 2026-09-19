import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

/**
 * The lifecycle, against the real schema.
 *
 * These are the two claims the on-demand design rests on, and neither can be
 * checked with a unit test: that clicking Start costs a database query and no
 * model call when the bank has stock, and that a paper somebody is part-way
 * through survives the model being unreachable. So this boots the canonical
 * schema in PGlite, points the real query builder at it, and stubs the model
 * out entirely — a generation attempt that reaches the network is a failure
 * the test is looking for, not an accident.
 */

process.env.DB_DRIVER = 'native';
process.env.DATABASE_URL = 'postgres://stub/stub';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';
// Assessments refuse to run without a model configured. The stub below makes
// sure no call ever actually leaves.
process.env.LLM_API_KEY = 'test-key';
process.env.ASSESSMENT_DRAW_LIMIT = '3';

const { db } = await import('../src/lib/supabase.js');
const {
  createAssessment, getAssessment, saveAssessmentAnswer, submitAssessment,
} = await import('../src/services/assessment.service.js');

/* -------------------------------------------------------------------------- */

let modelCalls = 0;
const realFetch = globalThis.fetch;

/** A model that is reachable but refuses, so a failure costs no wall clock. */
globalThis.fetch = async (url) => {
  if (typeof url === 'string' && url.includes('supabase')) return realFetch(url);
  modelCalls += 1;
  return {
    ok: false,
    status: 400,
    json: async () => ({ error: { message: 'no model in tests' } }),
  };
};

async function database() {
  const pg = new PGlite();
  await pg.exec('create role anon; create role authenticated; create role service_role;');
  const source = await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pg.exec(source.replace('create extension if not exists "pgcrypto";', ''));

  // PostgresClient only ever reaches for `pool.query`, so a PGlite handle with
  // the same shape is a complete substitute for the driver.
  db.pool = {
    query: async (sql, parameters) => {
      const result = await pg.query(sql, parameters);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  return pg;
}

const mcqPayload = (index) => ({
  kind: 'mcq',
  label: `Concept ${index}`,
  prompt: `A question long enough to read as a real interview question, number ${index}.`,
  context: '',
  diagram: { type: 'mermaid', source: `graph LR\n  A[Client ${index}] --> B[Limiter]`, caption: 'write path' },
  selectionMode: 'single',
  options: [`right ${index}`, `wrong a ${index}`, `wrong b ${index}`, `wrong c ${index}`],
  correctAnswers: [`right ${index}`],
  explanation: 'The key follows from the stated constraint, the closest distractor does not.',
});

async function seed(pg, { bankedQuestions }) {
  const user = (await pg.query(
    `insert into users (email, name, password_hash, timezone)
     values ('student@example.com', 'Student', 'x', 'Asia/Kolkata') returning *`,
  )).rows[0];

  const problem = (await pg.query(
    `insert into problems (slug, title, kind, topic, difficulty, description, assessment_enabled, coding_enabled, order_index)
     values ('design-rate-limiter', 'Design Rate Limiter', 'HLD', 'Rate limiting', 'Medium', 'A rate limiter.', true, false, 1)
     returning *`,
  )).rows[0];

  for (let index = 0; index < bankedQuestions; index += 1) {
    await pg.query(
      `insert into assessment_questions
         (problem_id, kind, concept_area, difficulty, payload, fingerprint, source, model_version, prompt_version, verified)
       values ($1, 'mcq', $2, 'Medium', $3, $4, 'catalog', 'test', 'test', true)`,
      [problem.id, `area ${index}`, JSON.stringify(mcqPayload(index)), `fingerprint-${index}`],
    );
  }
  return { user, problem };
}

/** The background fill is deliberately not awaited, so wait for it to settle. */
async function settled(user, attemptId, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { attempt } = await getAssessment(user, attemptId);
    if (attempt.generationComplete) return attempt;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error('generation never settled');
}

/* -------------------------------------------------------------------------- */

test('a warm bank opens the exam with no model call at all', async () => {
  const pg = await database();
  const { user, problem } = await seed(pg, { bankedQuestions: 10 });
  modelCalls = 0;

  const started = Date.now();
  const { attempt } = await createAssessment(user, problem.id);
  const elapsed = Date.now() - started;

  // The whole point: the click path reads, it does not generate.
  assert.equal(modelCalls, 0, 'createAssessment must not call the model on a warm bank');
  assert.equal(attempt.status, 'active');
  // Capped by the draw limit, not by what the bank happens to hold.
  assert.equal(attempt.questions.length, 3);
  assert.ok(attempt.startedAt, 'the clock starts server-side');
  assert.ok(elapsed < 2_000, `opening took ${elapsed}ms`);

  // The first question is genuinely present, diagram and all, with no key.
  const [first] = attempt.questions;
  assert.equal(first.type, 'mcq');
  assert.equal(first.options.length, 4);
  assert.equal(first.correctAnswers, undefined);
  assert.ok(attempt.questions.every((item) => item.diagram?.source.startsWith('graph LR')));
  assert.equal(first.diagram.caption, 'write path');

  // Let the background fill finish before the database goes away, or it runs
  // on into the next test's connection.
  await settled(user, attempt.id);
  await pg.close();
});

test('an unreachable model costs the missing questions, never the paper', async () => {
  const pg = await database();
  const { user, problem } = await seed(pg, { bankedQuestions: 3 });
  modelCalls = 0;

  const { attempt: opened } = await createAssessment(user, problem.id);
  assert.equal(opened.status, 'active');
  assert.equal(opened.questions.length, 3);

  // The other seven slots have nothing to draw and a model that refuses.
  const attempt = await settled(user, opened.id);
  assert.ok(modelCalls > 0, 'the background fill should have tried');

  // This is the regression that mattered: the old code wrote `failed` scoped to
  // a status set that included `active`, so one model hiccup destroyed a paper
  // the student was already answering.
  assert.equal(attempt.status, 'active');
  assert.equal(attempt.questions.length, 3);
  assert.equal(attempt.generationComplete, true, 'a settled fill must unblock submission');

  await pg.close();
});

test('the marks of questions that could not be written move to the ones that could', async () => {
  const pg = await database();
  const { user, problem } = await seed(pg, { bankedQuestions: 3 });

  const { attempt: opened } = await createAssessment(user, problem.id);
  const attempt = await settled(user, opened.id);
  assert.equal(attempt.questions.length, 3);

  // Seven of ten slots had nothing to draw and no model to write them. Their
  // marks move rather than the paper shrinking, so 80% still means 80% of the
  // same thing it meant when the paper was planned.
  const weights = attempt.questions.map((question) => question.weight);
  assert.equal(weights.reduce((total, weight) => total + weight, 0), 10);
  const heaviest = attempt.questions.reduce((best, item) => (item.weight > best.weight ? item : best));
  assert.equal(heaviest.weight, 8);

  // Get the light ones right and the heavy one wrong.
  for (const question of attempt.questions) {
    const correct = question.options.find((option) => option.startsWith('right'));
    const wrong = question.options.find((option) => option.startsWith('wrong'));
    await saveAssessmentAnswer(user, attempt.id, question.id, {
      values: [question.id === heaviest.id ? wrong : correct],
    });
  }

  const result = await submitAssessment(user, attempt.id);
  assert.equal(result.maxScore, 10);
  assert.equal(result.score, 2);
  assert.equal(result.passed, false);
  assert.equal(result.attempt.status, 'failed');

  // The key and explanation appear only now that it is submitted.
  assert.equal(result.attempt.review.length, 3);
  assert.ok(result.attempt.review[0].correctAnswers.length);

  // Exposure is recorded at submission, so the questions are spent exactly once.
  const exposures = await pg.query('select count(*)::int as count from assessment_exposures where user_id = $1', [user.id]);
  assert.equal(exposures.rows[0].count, 3);

  await pg.close();
});

test('an abandoned attempt spends nothing, so a false start costs the student no questions', async () => {
  const pg = await database();
  const { user, problem } = await seed(pg, { bankedQuestions: 10 });
  const { abandonAssessment } = await import('../src/services/assessment.service.js');

  const { attempt } = await createAssessment(user, problem.id);
  await settled(user, attempt.id);
  await abandonAssessment(user, attempt.id);

  // Recording exposure as each question published meant three false starts
  // burned thirty questions of a finite bank, permanently.
  const exposures = await pg.query('select count(*)::int as count from assessment_exposures where user_id = $1', [user.id]);
  assert.equal(exposures.rows[0].count, 0);

  // And the second attempt can still draw a full, unseen set.
  const second = await createAssessment(user, problem.id);
  assert.equal(second.attempt.questions.length, 3);

  await settled(user, second.attempt.id);
  await pg.close();
});
