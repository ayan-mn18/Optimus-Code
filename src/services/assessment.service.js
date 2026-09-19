import { env } from '../config/env.js';
import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';
import { completeAssessedProblem } from './challenge.service.js';
import { getProblemById } from './problem-catalog.service.js';
import {
  CODE_LANGUAGES, DEFAULT_LANGUAGE, getLanguage, languageChoices,
} from './runner/index.js';
import { runAnswer, redactResults } from './runner/grade.js';
import { PASS_RATIO, planBlueprint } from './assessment/blueprint.js';
import { assembleSlot, loadArticle, recordExposures, redistribute } from './assessment/bank.js';
import { PROMPT_VERSION } from './assessment/prompts.js';

const OPEN_STATUSES = ['generating', 'active', 'grading'];
const MAX_RUNS_PER_QUESTION = 20;

// node-postgres encodes JavaScript arrays as PostgreSQL array literals. The
// assessment paper is JSONB, so native PostgreSQL needs the JSON text form;
// PostgREST already accepts the structured value directly.
const jsonbValue = (value) => (env.database.driver === 'native' ? JSON.stringify(value) : value);

function assertLlmConfigured() {
  if (!env.ai.enabled) throw ApiError.serviceUnavailable('Optimus assessments require an LLM configuration');
}

/* -------------------------------------------------------------------------- */
/* Redaction — the answer key and the hidden tests never leave the server      */
/* -------------------------------------------------------------------------- */

/**
 * Attempts taken before v3 stored a flat question with the answer key alongside
 * it. Those papers are still readable history, so they are upgraded on the way
 * out rather than migrated or thrown away.
 */
export function upgradeLegacyEntry(entry) {
  if (entry.payload) return entry;
  return {
    slotId: entry.slotId ?? entry.id,
    questionId: null,
    type: 'mcq',
    weight: 1,
    conceptArea: entry.label ?? 'system design',
    difficulty: null,
    minutes: null,
    language: null,
    payload: {
      kind: 'mcq',
      label: entry.label ?? 'Question',
      prompt: entry.prompt ?? '',
      context: entry.context ?? '',
      selectionMode: entry.selectionMode ?? 'single',
      options: entry.options ?? [],
      correctAnswers: entry.correctAnswers ?? (entry.correctAnswer ? [entry.correctAnswer] : []),
      explanation: '',
    },
  };
}

export function publicQuestion(rawEntry) {
  const entry = upgradeLegacyEntry(rawEntry);
  const { payload } = entry;
  const base = { id: entry.slotId, type: entry.type, weight: entry.weight, conceptArea: entry.conceptArea };

  if (entry.type === 'mcq') {
    return {
      ...base,
      label: payload.label,
      prompt: payload.prompt,
      context: payload.context ?? '',
      selectionMode: payload.selectionMode,
      options: payload.options,
    };
  }

  if (entry.type === 'sql') {
    const sample = payload.tests.find((test) => test.visible);
    return {
      ...base,
      title: payload.title,
      statement: payload.statement,
      schema: payload.schema,
      orderMatters: payload.orderMatters,
      sampleSeed: sample?.seed ?? '',
      sampleName: sample?.name ?? 'sample',
      starter: getLanguage('sql').starter(),
    };
  }

  // Machine coding and debug. Only the visible tests travel, so a Run cannot
  // reveal what the grade actually turns on.
  const languages = entry.type === 'debug' ? [entry.language] : CODE_LANGUAGES;
  return {
    ...base,
    title: payload.title,
    statement: payload.statement,
    entity: payload.entity,
    languages: languageChoices().filter((choice) => languages.includes(choice.id)),
    minutes: entry.minutes ?? null,
    visibleTests: payload.tests.filter((test) => test.visible).map((test) => ({
      name: test.name,
      steps: test.steps,
    })),
    starters: Object.fromEntries(languages.map((id) => [
      id,
      entry.type === 'debug' ? payload.buggySource : getLanguage(id).starter({ entity: payload.entity }),
    ])),
  };
}

/** Shown only once the paper is submitted. */
function questionSolution(entry, result) {
  const { payload } = entry;
  if (entry.type === 'mcq') {
    return { correctAnswers: payload.correctAnswers, explanation: payload.explanation };
  }
  if (entry.type === 'sql') {
    return { referenceQuery: payload.referenceQuery, rubricNotes: payload.rubricNotes };
  }
  return {
    rubricNotes: payload.rubricNotes,
    ...(entry.type === 'debug' ? { bugSummary: payload.bugSummary } : {}),
    referenceSolution: payload.referenceSolution,
    results: result?.results ?? [],
  };
}

function publicAttempt(attempt, answers = []) {
  const settled = ['passed', 'failed'].includes(attempt.status);
  const entries = (attempt.question_set ?? []).map(upgradeLegacyEntry);
  const questions = entries.map(publicQuestion);
  const generation = attempt.blueprint?.generation ?? {};
  const generationComplete = generation.complete ?? (!attempt.blueprint?.generation || settled || !attempt.blueprint?.slots);
  const totalQuestions = generationComplete
    ? questions.length
    : Number(generation.target ?? attempt.blueprint?.slots?.length ?? questions.length);
  const graded = new Map((answers ?? []).map((answer) => [answer.question_id, answer]));

  return {
    id: attempt.id,
    problemId: attempt.problem_id,
    status: attempt.status,
    kind: attempt.blueprint?.kind ?? null,
    score: attempt.score === null || attempt.score === undefined ? null : Number(attempt.score),
    maxScore: attempt.max_score === null || attempt.max_score === undefined ? null : Number(attempt.max_score),
    passRatio: PASS_RATIO,
    language: attempt.language,
    startedAt: attempt.started_at,
    submittedAt: attempt.submitted_at,
    completedAt: attempt.completed_at,
    questionsReady: questions.length,
    totalQuestions,
    generationComplete,
    generationError: generation.error ?? null,
    questions,
    answers: Object.fromEntries((answers ?? []).map((answer) => [answer.question_id, answer.answer])),
    ...(settled
      ? {
        review: entries.map((entry) => {
          const answer = graded.get(entry.slotId);
          return {
            id: entry.slotId,
            score: answer?.score === undefined || answer?.score === null ? 0 : Number(answer.score),
            weight: entry.weight,
            feedback: answer?.feedback ?? '',
            ...questionSolution(entry, answer?.test_results ?? null),
          };
        }),
      }
      : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

async function loadOwnedAttempt(userId, attemptId) {
  const attempt = unwrap(
    await db.from('assessment_attempts').select('*').eq('id', attemptId).eq('user_id', userId).maybeSingle(),
    'load Optimus attempt',
  );
  if (!attempt) throw ApiError.notFound('Assessment not found');
  return attempt;
}

const entryFor = (attempt, questionId) => (attempt.question_set ?? [])
  .map(upgradeLegacyEntry)
  .find((entry) => entry.slotId === questionId);

export async function createAssessment(user, problemId, { language } = {}) {
  assertLlmConfigured();
  const problem = await getProblemById(problemId, '*', ['LLD', 'HLD']);
  if (!problem?.assessment_enabled) throw ApiError.notFound('Assessment problem not found');

  const existing = unwrap(
    await db
      .from('assessment_attempts')
      .select('*')
      .eq('user_id', user.id)
      .eq('problem_id', problemId)
      .in('status', OPEN_STATUSES)
      .maybeSingle(),
    'load active assessment',
  );
  if (existing) return getAssessment(user, existing.id);

  const chosen = CODE_LANGUAGES.includes(language) ? language : (user.preferred_language ?? DEFAULT_LANGUAGE);
  const prior = unwrap(
    await db.from('assessment_attempts').select('id').eq('user_id', user.id).eq('problem_id', problemId),
    'count prior assessments',
  );
  const article = await loadArticle(problemId);
  const blueprint = planBlueprint({
    problem,
    userId: user.id,
    attemptNumber: prior.length + 1,
    language: chosen,
    blogAvailable: Boolean(article),
  });
  blueprint.generation = { complete: false, ready: 0, target: blueprint.slots.length };

  const placeholder = unwrap(
    await db
      .from('assessment_attempts')
      .insert({
        user_id: user.id,
        problem_id: problemId,
        status: 'generating',
        model_version: env.ai.model,
        prompt_version: PROMPT_VERSION,
        blueprint,
        language: chosen,
        max_score: blueprint.maxScore,
      })
      .select('*')
      .single(),
    'create assessment',
  );

  // Paper assembly can involve several LLM and code-runner calls. Do not hold
  // the HTTP request open while those complete: the API returns the generating
  // attempt immediately and the client polls it until the paper is active.
  void prepareAssessment({ user, problem, blueprint, placeholder, article });
  return { attempt: publicAttempt(placeholder), problem };
}

async function prepareAssessment({ user, problem, blueprint, placeholder, article }) {
  try {
    const assembled = new Map();
    const usedQuestionIds = [];

    const questionEntry = (itemSlot, row) => ({
      slotId: itemSlot.id,
      questionId: row.id,
      type: itemSlot.type,
      weight: itemSlot.weight,
      conceptArea: row.concept_area,
      difficulty: row.difficulty,
      minutes: itemSlot.minutes ?? null,
      language: itemSlot.type === 'debug' ? row.payload.referenceSolution.language : null,
      payload: row.payload,
    });

    // Concurrent workers must not overwrite each other's question_set update.
    // Queue only the tiny database publish, never the slow model generation.
    let publishQueue = Promise.resolve();
    const publish = () => {
      const run = publishQueue.then(async () => {
        // Always publish in blueprint order even when background workers finish
        // out of order. This keeps q1, q2, ... stable in the exam UI.
        const questionSet = blueprint.slots
          .map((slot) => assembled.get(slot.id))
          .filter(Boolean)
          .map(({ slot: itemSlot, row }) => questionEntry(itemSlot, row));
        const progress = {
          ...blueprint,
          generation: { complete: false, ready: questionSet.length, target: blueprint.slots.length },
        };
        const published = unwrap(
          await db
            .from('assessment_attempts')
            .update({
              status: 'active',
              question_set: jsonbValue(questionSet),
              blueprint: progress,
              updated_at: new Date().toISOString(),
            })
            .eq('id', placeholder.id)
            .in('status', OPEN_STATUSES)
            .select('id')
            .maybeSingle(),
          'publish assessment question',
        );
        return Boolean(published);
      });
      publishQueue = run.catch(() => {});
      return run;
    };

    const prepareOne = async (slot) => {
      const current = unwrap(
        await db.from('assessment_attempts').select('status').eq('id', placeholder.id).maybeSingle(),
        'check assessment generation',
      );
      if (!current || !OPEN_STATUSES.includes(current.status)) return false;

      let result = await assembleSlot({
        problem, blueprint, userId: user.id, article, slot, usedQuestionIds: [...usedQuestionIds],
      });
      // Concurrent bank reads can select the same row. Retry only that rare
      // collision, keeping every question unique without serialising generation.
      if (result && usedQuestionIds.includes(result.row.id)) {
        result = await assembleSlot({
          problem, blueprint, userId: user.id, article, slot, usedQuestionIds: [...usedQuestionIds],
        });
      }
      if (!result) {
        if (slot.optional) return true;
        throw new Error(`Could not prepare ${slot.type} question ${slot.id}`);
      }

      usedQuestionIds.push(result.row.id);
      assembled.set(slot.id, result);
      if (!await publish()) return false;
      if (current.status === 'generating') {
        await db.from('assessment_attempts')
          .update({ started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', placeholder.id)
          .in('status', OPEN_STATUSES);
      }
      await recordExposures(user.id, placeholder.id, [result.row.id]);
      return true;
    };

    // Deliver q1 as soon as it is verified; prepare the rest in bounded,
    // independent workers so background generation cannot block the exam.
    if (!await prepareOne(blueprint.slots[0])) return;
    const remaining = blueprint.slots.slice(1);
    const workerCount = Math.min(env.assessment.generationConcurrency, remaining.length);
    let nextIndex = 0;
    const runWorker = async () => {
      while (nextIndex < remaining.length) {
        const slot = remaining[nextIndex];
        nextIndex += 1;
        if (!await prepareOne(slot)) return;
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    const dropped = blueprint.slots.filter((slot) => !assembled.has(slot.id));
    const ordered = blueprint.slots.map((slot) => assembled.get(slot.id)).filter(Boolean);
    const finalSet = redistribute(ordered, dropped)
      .map(({ slot: itemSlot, row }) => questionEntry(itemSlot, row));
    unwrap(
      await db
        .from('assessment_attempts')
        .update({
          status: 'active',
          question_set: jsonbValue(finalSet),
          blueprint: { ...blueprint, generation: { complete: true, ready: finalSet.length, target: blueprint.slots.length } },
          updated_at: new Date().toISOString(),
        })
        .eq('id', placeholder.id)
        .eq('status', 'active'),
      'finish assessment generation',
    );
  } catch (error) {
    await db.from('assessment_attempts')
      .update({
        status: 'failed',
        blueprint: {
          ...blueprint,
          generation: {
            complete: false,
            ready: 0,
            target: blueprint.slots.length,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', placeholder.id)
      .in('status', OPEN_STATUSES);
    console.error('[optimus] paper assembly failed:', error instanceof Error ? error.message : error);
  }
}

// A process restart can interrupt the in-process generation task. Keep the
// attempt open and resume it on the next worker tick instead of leaving the
// student on a permanent loading screen. The set prevents duplicate work
// while a slow LLM call is still in flight.
const resumingAttempts = new Set();

export async function resumeGeneratingAssessments({ limit = 10 } = {}) {
  const rows = unwrap(
    await db
      .from('assessment_attempts')
      .select('id, user_id, problem_id, blueprint, language')
      .eq('status', 'generating')
      .order('created_at', { ascending: true })
      .limit(limit),
    'load generating assessments',
  );

  for (const row of rows) {
    if (resumingAttempts.has(row.id)) continue;
    const blueprint = row.blueprint;
    if (!blueprint?.slots?.length) {
      await db.from('assessment_attempts').update({
        status: 'failed',
        updated_at: new Date().toISOString(),
      }).eq('id', row.id).eq('status', 'generating');
      continue;
    }

    resumingAttempts.add(row.id);
    void (async () => {
      try {
        const [user, problem] = await Promise.all([
          unwrap(await db.from('users').select('id, email, name, timezone, preferred_language').eq('id', row.user_id).maybeSingle(), 'load assessment owner'),
          getProblemById(row.problem_id, '*', ['LLD', 'HLD']),
        ]);
        if (!user || !problem?.assessment_enabled) return;
        await prepareAssessment({
          user,
          problem,
          blueprint: blueprint.generation ? blueprint : {
            ...blueprint,
            generation: { complete: false, ready: 0, target: blueprint.slots.length },
          },
          placeholder: row,
          article: await loadArticle(row.problem_id),
        });
      } catch (error) {
        console.error('[optimus] could not resume assessment', row.id, error instanceof Error ? error.message : error);
      } finally {
        resumingAttempts.delete(row.id);
      }
    })();
  }
  return rows.length;
}

export async function getAssessment(user, attemptId) {
  const attempt = await loadOwnedAttempt(user.id, attemptId);
  const [answers, problem] = await Promise.all([
    unwrap(await db.from('assessment_answers').select('*').eq('attempt_id', attempt.id), 'load assessment answers'),
    getProblemById(attempt.problem_id, 'id, title, kind, topic, subtopic, difficulty'),
  ]);
  return { attempt: publicAttempt(attempt, answers), problem };
}

/* -------------------------------------------------------------------------- */
/* Answering                                                                   */
/* -------------------------------------------------------------------------- */

function validateAnswer(entry, answer) {
  if (entry.type === 'mcq') {
    const values = Array.isArray(answer?.values) ? answer.values : [];
    if (values.some((value) => !entry.payload.options.includes(value))) {
      throw ApiError.badRequest('Answer contains an invalid option');
    }
    if (entry.payload.selectionMode === 'single' && values.length > 1) throw ApiError.badRequest('Choose one option');
    return { values };
  }

  if (entry.type === 'sql') {
    const source = String(answer?.source ?? '').trim();
    if (!source) throw ApiError.badRequest('Write a query first');
    return { language: 'sql', source };
  }

  const language = entry.language ?? answer?.language;
  if (!CODE_LANGUAGES.includes(language)) throw ApiError.badRequest('Choose a supported language');
  const source = String(answer?.source ?? '');
  if (!source.trim()) throw ApiError.badRequest('Write some code first');
  return { language, source };
}

export async function saveAssessmentAnswer(user, attemptId, questionId, answer) {
  const attempt = await loadOwnedAttempt(user.id, attemptId);
  if (attempt.status !== 'active') throw ApiError.conflict('Assessment no longer accepts answers');
  const entry = entryFor(attempt, questionId);
  if (!entry) throw ApiError.notFound('Question not found');

  const stored = validateAnswer(entry, answer);
  return unwrap(
    await db
      .from('assessment_answers')
      .upsert({
        attempt_id: attempt.id,
        question_id: questionId,
        answer: stored,
        language: stored.language ?? null,
        source_code: stored.source ?? null,
        submitted_at: new Date().toISOString(),
      }, { onConflict: 'attempt_id,question_id' })
      .select('question_id, answer, submitted_at')
      .single(),
    'save assessment answer',
  );
}

/**
 * The Run button: sample tests only.
 *
 * The program built here does not contain the hidden tests at all, so no amount
 * of printing from inside a student's own code can reveal them.
 */
export async function runAssessmentAnswer(user, attemptId, questionId, answer) {
  const attempt = await loadOwnedAttempt(user.id, attemptId);
  if (attempt.status !== 'active') throw ApiError.conflict('Assessment no longer accepts answers');
  const entry = entryFor(attempt, questionId);
  if (!entry) throw ApiError.notFound('Question not found');
  if (entry.type === 'mcq') throw ApiError.badRequest('This question is not run');

  const stored = validateAnswer(entry, answer);
  const existing = unwrap(
    await db.from('assessment_answers').select('id, run_count').eq('attempt_id', attempt.id).eq('question_id', questionId).maybeSingle(),
    'load run count',
  );
  if ((existing?.run_count ?? 0) >= MAX_RUNS_PER_QUESTION) {
    throw ApiError.conflict(`You have used all ${MAX_RUNS_PER_QUESTION} sample runs for this question. Submit when you are ready.`);
  }

  const run = await runAnswer({
    question: entry.payload,
    languageId: stored.language,
    source: stored.source,
    includeHidden: false,
  });

  unwrap(
    await db
      .from('assessment_answers')
      .upsert({
        attempt_id: attempt.id,
        question_id: questionId,
        answer: stored,
        language: stored.language,
        source_code: stored.source,
        run_count: (existing?.run_count ?? 0) + 1,
        submitted_at: new Date().toISOString(),
      }, { onConflict: 'attempt_id,question_id' })
      .select('id')
      .single(),
    'save run',
  );

  return {
    passed: run.passed,
    passedCount: run.passedCount,
    total: run.total,
    results: run.results,
    stderr: run.stderr,
    compileOutput: run.compileOutput,
    status: run.status,
    time: run.time,
    memory: run.memory,
    runsLeft: MAX_RUNS_PER_QUESTION - ((existing?.run_count ?? 0) + 1),
  };
}

/* -------------------------------------------------------------------------- */
/* Grading                                                                     */
/* -------------------------------------------------------------------------- */

export function scoreMultipleChoice(question, answer) {
  const selected = [...new Set(Array.isArray(answer?.values) ? answer.values : [])].sort();
  const expected = [...new Set(question.correctAnswers ?? [])].sort();
  const correct = selected.length === expected.length && selected.every((value, index) => value === expected[index]);
  return correct
    ? { ratio: 1, feedback: 'Correct.' }
    : { ratio: 0, feedback: 'Review this concept before retrying.' };
}

async function gradeEntry(entry, answer) {
  if (entry.type === 'mcq') {
    const { ratio, feedback } = scoreMultipleChoice(entry.payload, answer.answer);
    return { ratio, feedback, testResults: null };
  }

  const run = await runAnswer({
    question: entry.payload,
    languageId: answer.answer.language,
    source: answer.answer.source,
    includeHidden: true,
  });
  const ratio = run.total ? run.passedCount / run.total : 0;
  return {
    ratio,
    feedback: run.passed
      ? 'All tests passed.'
      : `${run.passedCount} of ${run.total} tests passed.${run.compileOutput ? ' The code did not compile.' : ''}`,
    testResults: {
      passedCount: run.passedCount,
      total: run.total,
      status: run.status,
      results: redactResults(run.results),
    },
  };
}

export async function submitAssessment(user, attemptId) {
  const attempt = await loadOwnedAttempt(user.id, attemptId);
  if (['passed', 'failed'].includes(attempt.status)) throw ApiError.conflict('Assessment was already submitted');
  const generationComplete = attempt.blueprint?.generation?.complete ?? true;
  if (!generationComplete) throw ApiError.conflict('Assessment is still preparing. Please wait for the remaining questions.');

  const answers = unwrap(
    await db.from('assessment_answers').select('*').eq('attempt_id', attempt.id),
    'load submitted answers',
  );
  const answerByQuestion = new Map(answers.map((answer) => [answer.question_id, answer]));
  const missing = attempt.question_set.map(upgradeLegacyEntry).filter((entry) => !answerByQuestion.has(entry.slotId));
  if (missing.length && attempt.status === 'active') {
    throw ApiError.badRequest(`Answer every question before submitting (${missing.length} remaining)`);
  }

  const grading = attempt.status === 'grading' ? attempt : unwrap(
    await db
      .from('assessment_attempts')
      .update({ status: 'grading', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', attempt.id)
      .eq('status', 'active')
      .select('*')
      .maybeSingle(),
    'lock assessment submission',
  );
  if (!grading) throw ApiError.conflict('Assessment was already submitted');

  let total = 0;
  const results = [];
  try {
    for (const entry of attempt.question_set.map(upgradeLegacyEntry)) {
      const answer = answerByQuestion.get(entry.slotId);
      const graded = await gradeEntry(entry, answer);
      const score = Number((graded.ratio * entry.weight).toFixed(2));
      total += score;
      results.push({ questionId: entry.slotId, score, weight: entry.weight, ...graded });
    }
  } catch (error) {
    // A runner outage is not a failed assessment. The attempt stays in
    // `grading` and the worker finishes it; nobody loses a day over it.
    if (error instanceof ApiError && [502, 503, 504].includes(error.status)) {
      await db.from('assessment_attempts').update({ updated_at: new Date().toISOString() }).eq('id', attempt.id);
      return { pending: true, attempt: publicAttempt({ ...grading, status: 'grading' }, answers) };
    }
    await db
      .from('assessment_attempts')
      .update({ status: 'active', submitted_at: null, updated_at: new Date().toISOString() })
      .eq('id', attempt.id);
    throw error;
  }

  await Promise.all(results.map((result) => {
    const answer = answerByQuestion.get(result.questionId);
    return db
      .from('assessment_answers')
      .update({
        score: result.score,
        feedback: result.feedback,
        test_results: result.testResults,
        graded_at: new Date().toISOString(),
      })
      .eq('id', answer.id);
  }));

  const maxScore = Number(attempt.max_score ?? attempt.blueprint?.maxScore ?? attempt.question_set.length);
  const passed = maxScore > 0 && total / maxScore >= PASS_RATIO;
  const completedAt = new Date().toISOString();
  const final = unwrap(
    await db
      .from('assessment_attempts')
      .update({
        status: passed ? 'passed' : 'failed',
        score: Number(total.toFixed(2)),
        max_score: maxScore,
        completed_at: completedAt,
        updated_at: completedAt,
      })
      .eq('id', attempt.id)
      .select('*')
      .single(),
    'finish assessment',
  );

  const gradedAnswers = unwrap(
    await db.from('assessment_answers').select('*').eq('attempt_id', attempt.id),
    'reload graded answers',
  );
  if (passed) await completeAssessedProblem(user, attempt.problem_id);
  return {
    attempt: publicAttempt(final, gradedAnswers),
    passed,
    score: Number(total.toFixed(2)),
    maxScore,
  };
}

/** Close an open attempt and discard its answers. The question bank remains reusable. */
export async function abandonAssessment(user, attemptId) {
  const deleted = unwrap(
    await db
      .from('assessment_attempts')
      .delete()
      .eq('id', attemptId)
      .eq('user_id', user.id)
      .in('status', OPEN_STATUSES)
      .select('id')
      .maybeSingle(),
    'abandon assessment',
  );
  if (!deleted) throw ApiError.conflict('Assessment is no longer open');
  return { abandoned: true, attemptId: deleted.id };
}

/**
 * Finishes attempts whose grading was interrupted by a runner outage.
 * Idempotent: an attempt that already settled is skipped.
 */
export async function settlePendingGrades({ olderThanMs = 60_000 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const stuck = unwrap(
    await db
      .from('assessment_attempts')
      .select('id, user_id')
      .eq('status', 'grading')
      .lt('updated_at', cutoff)
      .limit(10),
    'load stuck assessments',
  );

  let settled = 0;
  for (const row of stuck) {
    const user = unwrap(
      await db.from('users').select('id, timezone, preferred_language').eq('id', row.user_id).maybeSingle(),
      'load assessment owner',
    );
    if (!user) continue;
    try {
      const result = await submitAssessment(user, row.id);
      if (!result.pending) settled += 1;
    } catch (error) {
      console.error('[optimus] could not settle attempt', row.id, error instanceof Error ? error.message : error);
    }
  }
  return settled;
}

export { PASS_RATIO };
