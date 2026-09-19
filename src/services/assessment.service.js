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
import {
  assembleSlot, bankInventory, drawFromBank, loadArticle, recordExposures, redistribute, storeQuestions,
} from './assessment/bank.js';
import { generateOpener, toBankRow } from './assessment/generator.js';
import { assessmentChat } from './assessment/llm.js';
import { PROMPT_VERSION } from './assessment/prompts.js';

const OPEN_STATUSES = ['generating', 'active', 'grading'];
// A paper being graded is finished as far as generation is concerned — a
// background slot must never append a question to one.
const GENERATING_STATUSES = ['generating', 'active'];
const MAX_RUNS_PER_QUESTION = 20;

/** One slot of a paper, as it is stored on the attempt. */
const questionEntry = (slot, row) => ({
  slotId: slot.id,
  questionId: row.id,
  type: slot.type,
  weight: slot.weight,
  conceptArea: row.concept_area,
  difficulty: row.difficulty,
  minutes: slot.minutes ?? null,
  language: slot.type === 'debug' ? row.payload.referenceSolution.language : null,
  payload: row.payload,
});

// Assessment generation is one-way progress from server to browser. Keep the
// live subscribers in memory; the database remains the source of truth, so a
// reconnect always starts with a fresh snapshot and no event is lost.
const assessmentSubscribers = new Map();
const assessmentEmitQueues = new Map();

export function subscribeAssessment(attemptId, listener) {
  const listeners = assessmentSubscribers.get(attemptId) ?? new Set();
  listeners.add(listener);
  assessmentSubscribers.set(attemptId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) assessmentSubscribers.delete(attemptId);
  };
}

function emitAssessmentUpdate(user, attemptId) {
  if (!assessmentSubscribers.has(attemptId)) return;
  const previous = assessmentEmitQueues.get(attemptId) ?? Promise.resolve();
  const next = previous.then(async () => {
    const listeners = assessmentSubscribers.get(attemptId);
    if (!listeners?.size) return;
    const snapshot = await getAssessment(user, attemptId);
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[optimus] assessment stream listener failed:', error instanceof Error ? error.message : error);
      }
    }
  });
  assessmentEmitQueues.set(attemptId, next.catch(() => {}));
}

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
      diagram: null,
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
      // Questions written before diagrams existed simply have none.
      diagram: payload.diagram ?? null,
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

  // Four independent reads. Serialising them put half a second on the one
  // request a student is actually watching, for no reason at all.
  const [problem, existing, prior, article] = await Promise.all([
    getProblemById(problemId, '*', ['LLD', 'HLD']),
    (async () => unwrap(
      await db.from('assessment_attempts').select('*')
        .eq('user_id', user.id).eq('problem_id', problemId).in('status', OPEN_STATUSES).maybeSingle(),
      'load active assessment',
    ))(),
    (async () => unwrap(
      await db.from('assessment_attempts').select('id').eq('user_id', user.id).eq('problem_id', problemId),
      'count prior assessments',
    ))(),
    loadArticle(problemId),
  ]);

  if (!problem?.assessment_enabled) throw ApiError.notFound('Assessment problem not found');
  if (existing) return getAssessment(user, existing.id);

  const chosen = CODE_LANGUAGES.includes(language) ? language : (user.preferred_language ?? DEFAULT_LANGUAGE);
  const blueprint = planBlueprint({
    problem,
    userId: user.id,
    attemptNumber: prior.length + 1,
    language: chosen,
    blogAvailable: Boolean(article),
  });

  // The click path reads and nothing else — no model call, ever, not even for a
  // problem with an empty bank. Whatever the bank can supply, up to the draw
  // limit, is what the exam opens on; anything else arrives over the stream.
  const drawn = await drawFromBank({ problem, blueprint, userId: user.id, limit: env.assessment.drawLimit });
  const seeded = drawn.entries;
  const questionSet = seeded.map(({ slot, row }) => questionEntry(slot, row));
  const startedAt = questionSet.length ? new Date().toISOString() : null;
  const attempt = unwrap(
    await db
      .from('assessment_attempts')
      .insert({
        user_id: user.id,
        problem_id: problemId,
        status: questionSet.length ? 'active' : 'generating',
        model_version: env.ai.model,
        prompt_version: PROMPT_VERSION,
        blueprint: {
          ...blueprint,
          generation: { complete: false, ready: questionSet.length, target: blueprint.slots.length },
        },
        language: chosen,
        max_score: blueprint.maxScore,
        question_set: jsonbValue(questionSet),
        started_at: startedAt,
      })
      .select('*')
      .single(),
    'create assessment',
  );

  // Everything the draw could not cover is written behind the student. Each
  // one checks the bank again first, so a paper gets cheaper as the bank fills.
  void fillRemaining({ user, problem, blueprint, attempt, article, seeded });
  return { attempt: publicAttempt(attempt), problem };
}

/**
 * The first question for a problem with an empty bank.
 *
 * Runs at the head of the background fill, not on the request — blocking the
 * POST on a model call is the thing this whole design exists to stop, and a
 * student staring at an empty screen while the API holds the connection open
 * is worse than one watching a question arrive over the stream.
 *
 * Deliberately never a coding question: those take minutes. The prompt is
 * stripped to what a fair question needs and nothing more, it gets one attempt
 * on a short clock, and it is banked like anything else — so the second student
 * on this problem draws it instead of paying for it.
 */
async function openFirstQuestion({ problem, blueprint, usedQuestionIds }) {
  const slot = blueprint.slots.find((entry) => entry.type === 'mcq');
  if (!slot) return null;
  try {
    const generated = await generateOpener({
      problem,
      slot,
      seed: `${blueprint.seed}:${slot.id}`,
      chatImpl: assessmentChat(problem.id),
    });
    const [row] = await storeQuestions([toBankRow({ problem, generated })]);
    if (!row || usedQuestionIds.has(row.id)) return null;
    return { slot, row };
  } catch (error) {
    console.warn('[optimus] cold-start opener failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Writes the rest of the paper while the student answers what they already have.
 *
 * Three properties matter here. Slots are independent, so they are issued
 * together rather than queued — multiple choice first because it is quick,
 * then coding, then the debug exercise which needs a verified question to
 * break. Every question is banked as it lands, so the next student for this
 * problem draws it. And a slot that cannot be written is dropped, never fatal:
 * an attempt somebody is part-way through must never be failed from back here.
 */
async function fillRemaining({ user, problem, blueprint, attempt, article, seeded }) {
  const attemptId = attempt.id;
  const assembled = new Map(seeded.map((entry) => [entry.slot.id, entry]));
  const usedQuestionIds = new Set(seeded.map((entry) => entry.row.id));
  let needsStart = !attempt.started_at;

  // Concurrent slots must not overwrite each other's question_set update.
  // Queue only the tiny database publish, never the slow model generation.
  let publishQueue = Promise.resolve();
  const publish = () => {
    const run = publishQueue.then(async () => {
      // Always publish in blueprint order even when slots finish out of order,
      // so q1, q2, … stay stable in the exam UI.
      const questionSet = blueprint.slots
        .map((slot) => assembled.get(slot.id))
        .filter(Boolean)
        .map(({ slot, row }) => questionEntry(slot, row));
      const published = unwrap(
        await db
          .from('assessment_attempts')
          .update({
            status: 'active',
            question_set: jsonbValue(questionSet),
            blueprint: {
              ...blueprint,
              generation: { complete: false, ready: questionSet.length, target: blueprint.slots.length },
            },
            ...(needsStart ? { started_at: new Date().toISOString() } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq('id', attemptId)
          .in('status', GENERATING_STATUSES)
          .select('id')
          .maybeSingle(),
        'publish assessment question',
      );
      if (published) needsStart = false;
      // Do not make generation wait for a browser. The queued emitter
      // serialises snapshots so a later question cannot overtake an earlier one.
      emitAssessmentUpdate(user, attemptId);
      return Boolean(published);
    });
    publishQueue = run.catch(() => {});
    return run;
  };

  const stillOpen = async () => {
    const current = unwrap(
      await db.from('assessment_attempts').select('status').eq('id', attemptId).maybeSingle(),
      'check assessment generation',
    );
    return Boolean(current && GENERATING_STATUSES.includes(current.status));
  };

  const prepareOne = async (slot) => {
    if (assembled.has(slot.id)) return;
    try {
      let result = await assembleSlot({
        problem, blueprint, userId: user.id, article, slot, usedQuestionIds: [...usedQuestionIds],
      });
      // Concurrent bank reads can select the same row. Retry only that rare
      // collision, keeping every question unique without serialising the fill.
      if (result && usedQuestionIds.has(result.row.id)) {
        result = await assembleSlot({
          problem, blueprint, userId: user.id, article, slot, usedQuestionIds: [...usedQuestionIds],
        });
      }
      // The opener races for the first slot, so check again on the way back.
      if (!result || usedQuestionIds.has(result.row.id) || assembled.has(slot.id)) return;
      usedQuestionIds.add(result.row.id);
      assembled.set(slot.id, result);
      await publish();
    } catch (error) {
      // A model hiccup costs one question, not the paper. The slot's weight is
      // redistributed when the fill finishes.
      console.warn(
        `[optimus] dropped ${slot.type} slot ${slot.id} on attempt ${attemptId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  };

  const runPool = async (slots, width) => {
    let next = 0;
    const worker = async () => {
      while (next < slots.length) {
        const slot = slots[next];
        next += 1;
        if (!await stillOpen()) return;
        await prepareOne(slot);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, slots.length) }, () => worker()));
  };

  try {
    // Nothing was drawn, so the student is looking at an empty screen. Race a
    // stripped-down question against the ordinary fan-out rather than queueing
    // it in front: it is usually the faster of the two, but when it is not,
    // waiting for it to fail costs the student its entire timeout — measured at
    // 12s of dead air before the real question arrived.
    const opener = assembled.size ? null : openFirstQuestion({ problem, blueprint, usedQuestionIds })
      .then(async (result) => {
        if (!result || assembled.has(result.slot.id) || usedQuestionIds.has(result.row.id)) return;
        usedQuestionIds.add(result.row.id);
        assembled.set(result.slot.id, result);
        await publish();
      })
      .catch(() => {});

    const remaining = blueprint.slots.filter((slot) => !assembled.has(slot.id));
    // Multiple choice is seconds and machine coding is minutes, and they share
    // nothing, so both start now — waiting for the quick ones first only
    // delayed the slow ones. A debug exercise is a broken copy of a verified
    // machine-coding question, so that one genuinely has to follow.
    const quick = runPool(
      remaining.filter((slot) => slot.type === 'mcq' || slot.type === 'sql'),
      env.assessment.generationConcurrency,
    );
    const coding = runPool(
      remaining.filter((slot) => slot.type === 'machine_coding'),
      env.assessment.codingConcurrency,
    ).then(() => runPool(remaining.filter((slot) => slot.type === 'debug'), 1));
    await Promise.all([opener, quick, coding]);

    const ordered = blueprint.slots.map((slot) => assembled.get(slot.id)).filter(Boolean);
    const missed = blueprint.slots.filter((slot) => !assembled.has(slot.id));

    if (!ordered.length) {
      // Nothing was written at all, so nobody is part-way through anything.
      // This is the only case where an attempt is failed, and it can only ever
      // apply to one still sitting in `generating`.
      await db.from('assessment_attempts')
        .update({
          status: 'failed',
          blueprint: {
            ...blueprint,
            generation: { complete: false, ready: 0, target: blueprint.slots.length, error: 'No question could be prepared' },
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', attemptId)
        .eq('status', 'generating');
      emitAssessmentUpdate(user, attemptId);
      return;
    }

    const finalSet = redistribute(ordered, missed).map(({ slot, row }) => questionEntry(slot, row));
    unwrap(
      await db
        .from('assessment_attempts')
        .update({
          status: 'active',
          question_set: jsonbValue(finalSet),
          blueprint: {
            ...blueprint,
            generation: {
              complete: true,
              ready: finalSet.length,
              target: blueprint.slots.length,
              ...(missed.length ? { dropped: missed.map((slot) => slot.id) } : {}),
            },
          },
          ...(needsStart ? { started_at: new Date().toISOString() } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', attemptId)
        .in('status', GENERATING_STATUSES),
      'finish assessment generation',
    );
    emitAssessmentUpdate(user, attemptId);
  } catch (error) {
    // Even here the paper stays open. Mark generation settled on what exists so
    // the student can finish and submit rather than waiting on a dead fill.
    console.error('[optimus] paper fill failed:', error instanceof Error ? error.message : error);
    await db.from('assessment_attempts')
      .update({
        blueprint: {
          ...blueprint,
          generation: {
            complete: true,
            ready: assembled.size,
            target: blueprint.slots.length,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', attemptId)
      .in('status', GENERATING_STATUSES);
    emitAssessmentUpdate(user, attemptId);
  }
}

// A process restart can interrupt an in-flight fill. The attempt stays open and
// is resumed on the next worker tick rather than leaving the student on a
// half-written paper they cannot submit. The set prevents duplicate work while
// a slow model call is still running in this process.
const resumingAttempts = new Set();

/**
 * Finishes papers whose generation was cut short.
 *
 * An attempt goes `active` the moment its first question publishes, so looking
 * only at `generating` — as this once did — missed every paper interrupted
 * after that point and left it unfinishable for good.
 */
export async function resumeIncompleteAssessments({ limit = 10 } = {}) {
  const rows = unwrap(
    await db
      .from('assessment_attempts')
      .select('id, user_id, problem_id, blueprint, language, started_at, status')
      .in('status', GENERATING_STATUSES)
      .order('created_at', { ascending: true })
      .limit(60),
    'load unfinished assessments',
  );

  const unfinished = rows
    .filter((row) => row.blueprint?.generation && row.blueprint.generation.complete !== true)
    .filter((row) => !resumingAttempts.has(row.id))
    .slice(0, limit);

  for (const row of unfinished) {
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
        const [user, problem, current] = await Promise.all([
          (async () => unwrap(await db.from('users').select('id, email, name, timezone, preferred_language').eq('id', row.user_id).maybeSingle(), 'load assessment owner'))(),
          getProblemById(row.problem_id, '*', ['LLD', 'HLD']),
          (async () => unwrap(await db.from('assessment_attempts').select('question_set, started_at').eq('id', row.id).maybeSingle(), 'load partial paper'))(),
        ]);
        if (!user || !problem?.assessment_enabled) return;

        // Whatever already published is kept; only the gaps are rewritten.
        const already = (current?.question_set ?? []).map(upgradeLegacyEntry);
        const bySlot = new Map(already.map((entry) => [entry.slotId, entry]));
        const seeded = blueprint.slots
          .filter((slot) => bySlot.has(slot.id))
          .map((slot) => {
            const entry = bySlot.get(slot.id);
            return {
              slot,
              row: {
                id: entry.questionId,
                concept_area: entry.conceptArea,
                difficulty: entry.difficulty,
                payload: entry.payload,
              },
            };
          });

        await fillRemaining({
          user,
          problem,
          blueprint,
          attempt: { id: row.id, started_at: current?.started_at ?? row.started_at },
          article: await loadArticle(row.problem_id),
          seeded,
        });
      } catch (error) {
        console.error('[optimus] could not resume assessment', row.id, error instanceof Error ? error.message : error);
      } finally {
        resumingAttempts.delete(row.id);
      }
    })();
  }
  return unfinished.length;
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

  const entries = (attempt.question_set ?? []).map(upgradeLegacyEntry);
  if (!entries.length) throw ApiError.conflict('This assessment has no questions to submit');

  const answers = unwrap(
    await db.from('assessment_answers').select('*').eq('attempt_id', attempt.id),
    'load submitted answers',
  );
  const answerByQuestion = new Map(answers.map((answer) => [answer.question_id, answer]));
  const missing = entries.filter((entry) => !answerByQuestion.has(entry.slotId));
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

  // Exposure is recorded here rather than as each question publishes. A student
  // who opens a paper and quits has not seen anything worth burning, and doing
  // it at publish time meant three false starts cost them thirty questions of
  // a finite bank — permanently, since exposure is what the draw filters on.
  await recordExposures(user.id, attempt.id, entries.map((entry) => entry.questionId).filter(Boolean));

  let total = 0;
  const results = [];
  try {
    for (const entry of entries) {
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

  // A paper whose fill was cut short is marked out of the questions it actually
  // contains. Scoring 7 questions out of a planned 100 would make the pass mark
  // unreachable through no fault of the student.
  const presentWeight = entries.reduce((sum, entry) => sum + Number(entry.weight ?? 1), 0);
  const generationComplete = attempt.blueprint?.generation?.complete ?? true;
  const maxScore = generationComplete
    ? Number(attempt.max_score ?? attempt.blueprint?.maxScore ?? presentWeight)
    : presentWeight;
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

/**
 * How well the bank is covering demand.
 *
 * With no pre-seeding, depth is the metric that predicts student latency: a
 * problem with stock opens in a query, a problem without one pays for a
 * question. Reported per problem that has actually been assessed, because a
 * problem nobody has sat is supposed to have nothing.
 */
export async function bankHealth() {
  const attempts = unwrap(
    await db.from('assessment_attempts').select('problem_id, status, created_at').order('created_at', { ascending: false }).limit(500),
    'load assessment attempts',
  );
  const problemIds = [...new Set(attempts.map((row) => row.problem_id))];
  const inventory = await bankInventory(problemIds);

  const problems = await Promise.all(problemIds.map(async (problemId) => {
    const problem = await getProblemById(problemId, 'id, title, kind, coding_enabled');
    const depth = inventory.get(problemId) ?? {};
    return {
      problemId,
      title: problem?.title ?? null,
      kind: problem?.kind ?? null,
      codeable: problem?.coding_enabled === true,
      depth,
      total: Object.values(depth).reduce((sum, count) => sum + count, 0),
      attempts: attempts.filter((row) => row.problem_id === problemId).length,
    };
  }));

  problems.sort((left, right) => left.total - right.total);
  const banked = unwrap(
    await db.from('assessment_questions').select('kind').eq('verified', true).is('retired_at', null),
    'count banked questions',
  );

  return {
    problemsAssessed: problemIds.length,
    questionsBanked: banked.length,
    byKind: banked.reduce((totals, row) => ({ ...totals, [row.kind]: (totals[row.kind] ?? 0) + 1 }), {}),
    // The ones that will make somebody wait next.
    thinnest: problems.slice(0, 25),
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
