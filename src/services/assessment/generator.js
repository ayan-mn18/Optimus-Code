import { chatJson, LlmError } from '../../lib/llm.js';
import { env } from '../../config/env.js';
import { getLanguage } from '../runner/index.js';
import { runAnswer } from '../runner/grade.js';
import { createJudge0 } from '../runner/judge0.js';
import { SCHEMAS, diagramSchema, fingerprint } from './schemas.js';
import {
  PROMPT_VERSION, bugPrompt, mcqPrompt, openerPrompt, portPrompt, repairPrompt, repairTestsPrompt,
  specPrompt, sqlPrompt, testsPrompt,
} from './prompts.js';

/**
 * Writing a question is the easy half. Proving it is answerable is the other.
 *
 * Every coding question is executed before any student sees it: the model's own
 * reference solution must pass every test it wrote, and an empty skeleton must
 * fail — otherwise the tests assert nothing. A debug question must additionally
 * fail on its own buggy source, or there is no bug. A question that cannot
 * survive that gets one round trip to fix itself and is then thrown away.
 *
 * This is why the bank exists: the whole sequence costs the better part of a
 * minute, and no student should ever wait for it.
 */

export { PROMPT_VERSION };

/** Verification runs on its own low-concurrency transport so it cannot crowd out students. */
const verifyTransport = createJudge0({ config: { ...env.runner, concurrency: env.runner.bankConcurrency } });

class GenerationError extends Error {}

/**
 * Models rename fields. Showing the exact shape in the prompt stops most of it;
 * accepting the two or three synonyms they reach for anyway costs nothing and
 * saves a whole round trip when it happens.
 */
const camelise = (name) => String(name ?? '')
  .replace(/^[_\s-]+|[_\s-]+$/g, '')
  .replace(/[_\s-]+([a-zA-Z0-9])/g, (_match, char) => char.toUpperCase());

const className = (name) => {
  const camel = camelise(name);
  return camel ? camel[0].toUpperCase() + camel.slice(1) : camel;
};

function normaliseEntity(entity) {
  if (!entity || typeof entity !== 'object') return entity;
  const param = (item) => ({
    // A model that writes snake_case has not written a bad question, only a
    // differently spelled one. Harnesses call methods by the spec's name, so
    // one spelling has to win; camelCase is the one the prompt asks for.
    name: camelise(item?.name ?? item?.parameterName ?? item?.paramName),
    type: item?.type ?? item?.parameterType ?? item?.paramType,
  });
  const ctor = Object.hasOwn(entity, 'constructorParams') ? entity.constructorParams
    : Object.hasOwn(entity, 'constructor') ? entity.constructor
      : Object.hasOwn(entity, 'constructorArgs') ? entity.constructorArgs : [];
  return {
    name: className(entity.name ?? entity.className),
    constructorParams: (Array.isArray(ctor) ? ctor : []).map(param),
    methods: (entity.methods ?? []).map((method) => ({
      name: camelise(method?.name ?? method?.methodName),
      params: (method?.params ?? method?.parameters ?? []).map(param),
      returns: method?.returns ?? method?.returnType ?? method?.returnsType,
    })),
  };
}

/**
 * A step that checks the return value of a method declared `void` is a habit,
 * not a defect: there is nothing to check and the intent is unambiguous. Drop
 * the expectation rather than discarding an otherwise good question — a test
 * left with no checks at all is still caught by the schema.
 */
/**
 * Two more things a model does that are not defects.
 *
 * It spells "this call must raise" a dozen ways, so any of them becomes `throws`.
 * And it occasionally writes a scenario that only exercises the object without
 * checking anything — worth dropping on its own, not worth discarding a whole
 * verified question over, as long as the coverage minimums still hold.
 */
const MAX_TESTS = 30;

function normaliseTests(raw) {
  if (!Array.isArray(raw.tests)) return raw;
  const tests = raw.tests.map((test) => ({
    ...test,
    steps: (test.steps ?? []).map((step) => {
      const throws = step.throws ?? step.expectError ?? step.raises ?? step.shouldThrow ?? step.expectThrow;
      return throws ? { ...step, throws: true } : step;
    }),
  }));

  const checks = (test) => test.steps.slice(1).some((step) => Object.hasOwn(step, 'expect') || step.throws);
  const kept = tests.filter(checks);
  const visible = kept.filter((test) => test.visible).length;
  // Only drop the empty scenarios if what remains is still a real test suite.
  const usable = visible >= 2 && kept.length - visible >= 4;
  const chosen = usable ? kept : tests;

  // An over-eager suite is a good problem to have. Keep every visible scenario
  // and as many hidden ones as fit, rather than discarding an hour of work over
  // a cap that exists to bound the harness, not to judge the question.
  const trimmed = chosen.length <= MAX_TESTS
    ? chosen
    : [...chosen.filter((test) => test.visible), ...chosen.filter((test) => !test.visible)].slice(0, MAX_TESTS);

  return {
    ...raw,
    tests: trimmed,
    // Rubric notes are shown after the grade; length is not worth a discard.
    ...(typeof raw.rubricNotes === 'string' ? { rubricNotes: raw.rubricNotes.slice(0, 2500) } : {}),
  };
}

function dropVoidExpectations(raw) {
  const voids = new Set((raw.entity?.methods ?? []).filter((method) => method.returns === 'void').map((method) => method.name));
  if (!voids.size || !Array.isArray(raw.tests)) return raw;
  return {
    ...raw,
    tests: raw.tests.map((test) => ({
      ...test,
      steps: (test.steps ?? []).map((step) => {
        if (!voids.has(step.op)) return step;
        const rest = { ...step };
        delete rest.expect;
        return rest;
      }),
    })),
  };
}

/**
 * A key that differs from its option by whitespace or a trailing full stop is
 * the same answer written twice, not a broken question.
 */
function snapAnswers(raw) {
  if (!Array.isArray(raw.options) || !Array.isArray(raw.correctAnswers)) return raw;
  const key = (text) => String(text ?? '').toLowerCase().replace(/[\s.]+/g, ' ').trim();
  const byKey = new Map(raw.options.map((option) => [key(option), option]));
  return {
    ...raw,
    correctAnswers: raw.correctAnswers.map((answer) => byKey.get(key(answer)) ?? answer),
  };
}

/**
 * A diagram is a bonus, never a reason to lose the question.
 *
 * Models fence mermaid in backticks, wrap it in an extra object, or reach for a
 * diagram type that will not render. All of those are worth fixing or dropping;
 * none is worth discarding a good question over, so anything that does not
 * survive validation simply becomes no diagram.
 */
function normaliseDiagram(raw) {
  if (!Object.hasOwn(raw, 'diagram')) return raw;
  const candidate = raw.diagram;
  if (!candidate || typeof candidate !== 'object') return { ...raw, diagram: null };

  const source = String(candidate.source ?? candidate.code ?? candidate.mermaid ?? '')
    // Models fence the diagram roughly a third of the time.
    .replace(/^\s*```(?:mermaid)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const parsed = diagramSchema.safeParse({
    type: 'mermaid',
    source,
    caption: String(candidate.caption ?? '').slice(0, 200),
  });
  return { ...raw, diagram: parsed.success ? parsed.data : null };
}

function parseOne(kind, raw) {
  const input = raw?.entity
    ? normaliseTests(dropVoidExpectations({
      ...raw,
      entity: normaliseEntity(raw.entity),
      // Step operations name methods, so they are renamed the same way.
      tests: (raw.tests ?? []).map((test) => ({
        ...test,
        steps: (test.steps ?? []).map((step) => (step?.op === 'new' ? step : { ...step, op: camelise(step?.op) })),
      })),
    }))
    : normaliseDiagram(snapAnswers({ ...raw }));
  if (kind === 'debug' && input && !input.buggySource) {
    input.buggySource = input.buggyImplementation ?? input.buggyCode ?? input.brokenSource ?? input.flawedSource;
    input.bugSummary = input.bugSummary ?? input.bugsSummary ?? input.bugDescription;
  }
  const result = SCHEMAS[kind].safeParse({ kind, ...input });
  if (!result.success) {
    const issues = result.error.issues.slice(0, 6).map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`);
    throw new GenerationError(`Schema rejected the ${kind} question — ${issues.join('; ')}`);
  }
  return result.data;
}

/* -------------------------------------------------------------------------- */
/* Multiple choice                                                            */
/* -------------------------------------------------------------------------- */

export async function generateMcqSet({ problem, slots, seed, article, chatImpl = chatJson }) {
  const prompt = mcqPrompt({ problem, slots, seed, article });
  // MCQs are short, self-contained JSON objects, and the whole paper's worth of
  // them is issued in parallel rather than as one call — so the budget here is
  // per question, and reasoning effort is latency the student pays for nothing.
  // The fast model binding defaults to the main one, so this is inert until set.
  const startedAt = Date.now();
  const raw = await chatImpl({
    ...prompt,
    effort: env.assessment.mcqEffort,
    maxTokens: Math.max(env.assessment.mcqMaxTokens, slots.length * 900),
    model: env.ai.fastModel,
  });
  console.info(`[optimus] generated ${slots.length} MCQ question(s) in ${Date.now() - startedAt}ms`);
  // JSON-object mode providers occasionally unwrap a one-item question_set
  // into the question itself. Accept that harmless shape for a single slot;
  // the schema parser below still validates every field before banking it.
  const questions = Array.isArray(raw?.questions)
    ? raw.questions
    : slots.length === 1 && Array.isArray(raw?.options) ? [raw] : [];
  if (questions.length !== slots.length) {
    throw new GenerationError(`Expected ${slots.length} questions, received ${questions.length}`);
  }

  return questions.map((question, index) => {
    const slot = slots[index];
    const parsed = parseOne('mcq', {
      ...question,
      selectionMode: question.selectionMode ?? slot.selectionMode,
      context: question.context ?? '',
    });
    return {
      question: parsed,
      meta: {
        conceptArea: slot.conceptArea,
        difficulty: slot.difficulty,
        source: slot.source,
        language: null,
      },
    };
  });
}

/**
 * The one question a student may actually wait for.
 *
 * Reached only when a problem has nothing bankable — the first time anyone
 * assesses it. Everything that costs latency and is not strictly needed for a
 * fair question is stripped: no article, a short description, no exemplar, no
 * diagram, no strict grammar, and a hard timeout well under what the full
 * prompt is allowed. It is banked like any other question, so the second
 * student on this problem draws it instead of paying for it.
 */
export async function generateOpener({ problem, slot, seed, chatImpl = chatJson }) {
  const startedAt = Date.now();
  const raw = await chatImpl({
    ...openerPrompt({ problem, slot, seed }),
    effort: 'minimal',
    maxTokens: 900,
    model: env.ai.fastModel,
    timeoutMs: env.assessment.openerTimeoutMs,
    // One attempt. Retrying here would turn a 12s ceiling into a 39s one, and
    // the background fill is already writing this slot's replacement anyway.
    maxAttempts: 1,
  });
  const [question] = Array.isArray(raw?.questions) ? raw.questions : [];
  if (!question) throw new GenerationError('The opener call returned no question');
  console.info(`[optimus] generated cold-start opener in ${Date.now() - startedAt}ms`);

  return {
    question: parseOne('mcq', {
      ...question,
      selectionMode: 'single',
      context: question.context ?? '',
      diagram: null,
    }),
    meta: {
      conceptArea: slot.conceptArea,
      difficulty: slot.difficulty,
      source: 'catalog',
      language: null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Coding — machine coding and debug                                          */
/* -------------------------------------------------------------------------- */

export async function generateCodingQuestion({ problem, slot, seed, chatImpl = chatJson, transport = verifyTransport }) {
  const kind = 'machine_coding';

  // Contract and working code first; the test suite is written afterwards
  // against code the model can read rather than code it is predicting.
  const spec = await chatImpl({
    ...specPrompt({ problem, slot, seed }),
    effort: 'high',
    maxTokens: env.assessment.codingSpecMaxTokens,
  });
  const suite = await chatImpl({
    ...testsPrompt({ spec: { ...spec, entity: normaliseEntity(spec.entity) } }),
    effort: 'high',
    maxTokens: env.assessment.codingTestsMaxTokens,
  });

  let question = parseOne(kind, { ...spec, tests: suite?.tests ?? [] });
  let verification = await verifyCoding(question, transport);

  // First repair: re-derive only the expectations that disagree with the code.
  if (!verification.ok && verification.failedTests?.length) {
    const corrected = await chatImpl({
      ...repairTestsPrompt({ question, failures: verification.report }),
      effort: 'high',
      maxTokens: env.assessment.codingTestsMaxTokens,
    });
    const byName = new Map((corrected?.tests ?? []).map((test) => [test.name, test]));
    const merged = question.tests
      .map((test) => (byName.has(test.name) ? byName.get(test.name) : test))
      // A scenario the model could not reconcile is dropped rather than forced.
      .filter((test) => !verification.failedTests.includes(test.name) || byName.has(test.name));
    question = parseOne(kind, { ...question, tests: merged });
    verification = await verifyCoding(question, transport);
  }

  // Second repair: the disagreement was not arithmetic, so the whole question
  // gets one chance to reconcile itself.
  if (!verification.ok) {
    const repaired = await chatImpl({
      ...repairPrompt({ original: question, failure: verification.report, kind }),
      effort: 'high',
      maxTokens: 14_000,
    });
    question = parseOne(kind, repaired);
    verification = await verifyCoding(question, transport);
    if (!verification.ok) throw new GenerationError(`Verification failed after repair: ${verification.report}`);
  }

  return {
    question,
    verification: verification.record,
    meta: {
      conceptArea: slot.conceptArea,
      difficulty: slot.difficulty,
      source: 'catalog',
      language: null,   // a coding question is language-neutral; the student picks
    },
  };
}

/**
 * A debug question is a verified machine-coding question, ported to the
 * student's language and then broken on purpose. `base` is that verified
 * question — its tests and its reference have already been executed.
 */
export async function generateDebugQuestion({ problem, slot, seed, base, chatImpl = chatJson, transport = verifyTransport }) {
  const source = base ?? (await generateCodingQuestion({
    problem,
    slot: { ...slot, type: 'machine_coding', conceptArea: 'implementing the design' },
    seed,
    chatImpl,
    transport,
  })).question;

  const language = slot.language ?? source.referenceSolution.language;

  // Two separately verified steps rather than one. Porting the code and hiding a
  // bug in it are different jobs, and asking for both at once means a failure
  // never says which one went wrong — a Java port that quietly changes integer
  // division looks exactly like a bug that was planted on purpose.
  const correct = await verifiedPort({ base: source, language, chatImpl, transport });
  return plantBug({ base: source, slot, seed, correct, language, chatImpl, transport });
}

/** A port is faithful when it passes the scenarios the original passes. */
async function verifiedPort({ base, language, chatImpl, transport }) {
  if (language === base.referenceSolution.language) return base.referenceSolution.source;

  let failures;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { source } = await chatImpl({
      ...portPrompt({ base, language, failures }),
      effort: 'high',
      maxTokens: 16_000,
    });
    const run = await safeRun({ question: base, languageId: language, source, transport });
    if (run.passed) return source;
    failures = describe(`The ${language} port does not match the original`, run);
  }
  throw new GenerationError(`Could not port the reference to ${language}: ${failures}`);
}

async function plantBug({ base, slot, seed, correct, language, chatImpl, transport }) {
  const assemble = (raw) => parseOne('debug', {
    title: base.title,
    statement: base.statement,
    entity: base.entity,
    tests: base.tests,
    referenceSolution: { language, source: correct },
    buggySource: raw.buggySource,
    bugSummary: raw.bugSummary,
    rubricNotes: raw.rubricNotes || base.rubricNotes,
  });

  let observed;
  let previous;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await chatImpl({
      ...bugPrompt({ base, slot, seed: seed + attempt, correct, language, observed, previous }),
      effort: 'high',
      maxTokens: 16_000,
    });
    const question = assemble(raw);
    const verification = await verifyCoding(question, transport);
    if (verification.ok) {
      return {
        question,
        verification: verification.record,
        meta: { conceptArea: slot.conceptArea, difficulty: slot.difficulty, source: 'catalog', language },
        base,
      };
    }
    // The reference is already proven, so any failure here is the bug's fault.
    observed = verification.report;
    previous = raw.buggySource;
  }
  throw new GenerationError(`Debug verification failed: ${observed}`);
}

async function verifyCoding(question, transport) {
  const reference = question.referenceSolution;
  const referenceRun = await runAnswer({
    question,
    languageId: reference.language,
    source: reference.source,
    includeHidden: true,
    transport,
  });
  if (!referenceRun.passed) {
    return {
      ok: false,
      report: describe('The reference solution failed its own tests', referenceRun),
      failedTests: referenceRun.results.filter((result) => !result.passed).map((result) => result.name),
      record: null,
    };
  }

  // An empty skeleton that passes means the tests assert nothing.
  const stub = getLanguage(reference.language).starter({ entity: question.entity });
  const stubRun = await safeRun({ question, languageId: reference.language, source: stub, transport });
  if (stubRun.passed) {
    return { ok: false, report: 'An empty skeleton passes every test, so the tests check nothing.', record: null };
  }

  let buggyRun = null;
  if (question.kind === 'debug') {
    buggyRun = await safeRun({ question, languageId: reference.language, source: question.buggySource, transport });
    if (buggyRun.passed) {
      return { ok: false, report: 'The "buggy" source passes every test, so there is no bug to find.', record: null };
    }
    const visibleFailed = buggyRun.results.some((result) => result.visible && !result.passed);
    if (!visibleFailed) {
      return {
        ok: false,
        report: 'The buggy source passes every visible test, so the candidate has nothing to pull on. Make one visible scenario fail.',
        record: null,
      };
    }
  }

  return {
    ok: true,
    record: {
      checkedAt: new Date().toISOString(),
      referenceLanguage: reference.language,
      referencePassed: referenceRun.total,
      stubPassed: stubRun.passedCount,
      buggyFailed: buggyRun ? buggyRun.total - buggyRun.passedCount : null,
      runnerStatus: referenceRun.status,
    },
  };
}

/** A reference that crashes is a verification failure, not an exception. */
async function safeRun(options) {
  try {
    return await runAnswer({ ...options, includeHidden: true });
  } catch (error) {
    return { passed: false, passedCount: 0, total: 0, results: [], status: error.message ?? 'run failed' };
  }
}

function describe(headline, run) {
  const failures = run.results.filter((result) => !result.passed).slice(0, 8).map((result) => (result.error
    ? `  ${result.name}: ${result.error}`
    : `  ${result.name}: step ${result.step} expected ${result.expected}, got ${result.actual}`));
  return [
    headline,
    `status: ${run.status}`,
    run.compileOutput ? `compiler: ${run.compileOutput.slice(0, 600)}` : '',
    ...failures,
  ].filter(Boolean).join('\n');
}

/* -------------------------------------------------------------------------- */
/* SQL                                                                        */
/* -------------------------------------------------------------------------- */

export async function generateSqlQuestion({ problem, slot, seed, chatImpl = chatJson, transport = verifyTransport }) {
  const prompt = sqlPrompt({ problem, slot, seed });
  let question = parseOne('sql', await chatImpl({ ...prompt, effort: 'high', maxTokens: 8000 }));
  let built = await buildSqlAnswerKey(question, transport);

  if (!built.ok) {
    const repaired = await chatImpl({
      ...repairPrompt({ original: question, failure: built.report, kind: 'sql' }),
      effort: 'high',
      maxTokens: 8000,
    });
    question = parseOne('sql', repaired);
    built = await buildSqlAnswerKey(question, transport);
    if (!built.ok) throw new GenerationError(`SQL verification failed after repair: ${built.report}`);
  }

  return {
    question: built.question,
    verification: built.record,
    meta: { conceptArea: slot.conceptArea, difficulty: slot.difficulty, source: 'catalog', language: 'sql' },
  };
}

/**
 * The answer key for a SQL question is whatever the reference query actually
 * returns, so we run it rather than trusting the model to predict its own output.
 */
async function buildSqlAnswerKey(question, transport) {
  const tests = [];
  for (const [index, seed] of question.seeds.entries()) {
    const probe = {
      schema: question.schema,
      orderMatters: question.orderMatters,
      tests: [{ name: seed.name, visible: true, seed: seed.sql, expectedStdout: '' }],
    };
    const run = await safeRun({ question: probe, languageId: 'sql', source: question.referenceQuery, transport });
    const output = run.results[0]?.actual ?? '';
    if (run.results[0]?.error) {
      return { ok: false, report: `The reference query failed on seed "${seed.name}": ${run.results[0].error}` };
    }
    if (!output.trim()) {
      return { ok: false, report: `The reference query returns nothing on seed "${seed.name}". Seed data must exercise the question.` };
    }
    tests.push({ name: seed.name, visible: index === 0, seed: seed.sql, expectedStdout: output });
  }

  if (new Set(tests.map((test) => test.expectedStdout)).size < 2) {
    return { ok: false, report: 'Every seed produces the same result, so the hidden seeds test nothing. Vary the data.' };
  }

  return {
    ok: true,
    question: { ...question, tests },
    record: { checkedAt: new Date().toISOString(), seeds: tests.length, rows: tests.map((test) => test.expectedStdout.split('\n').length) },
  };
}

/* -------------------------------------------------------------------------- */

/** Generates whatever a blueprint slot asks for. MCQ slots are batched by the caller. */
export async function generateForSlot({ problem, slot, seed, article, base, chatImpl, transport }) {
  if (slot.type === 'sql') return [await generateSqlQuestion({ problem, slot, seed, chatImpl, transport })];
  if (slot.type === 'mcq') return generateMcqSet({ problem, slots: [slot], seed, article, chatImpl });
  if (slot.type === 'debug') return [await generateDebugQuestion({ problem, slot, seed, base, chatImpl, transport })];
  return [await generateCodingQuestion({ problem, slot, seed, chatImpl, transport })];
}

export function toBankRow({ problem, generated }) {
  return {
    problem_id: problem.id,
    kind: generated.question.kind,
    concept_area: generated.meta.conceptArea,
    difficulty: generated.meta.difficulty,
    language: generated.meta.language,
    payload: generated.question,
    fingerprint: fingerprint(generated.question),
    source: generated.meta.source,
    blog_id: generated.meta.blogId ?? null,
    model_version: env.ai.model,
    prompt_version: PROMPT_VERSION,
    verified: generated.question.kind === 'mcq' ? true : Boolean(generated.verification),
    verification: generated.verification ?? null,
  };
}

export { GenerationError, LlmError };
