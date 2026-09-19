import { db, unwrap } from '../../lib/supabase.js';
import { seededRandom } from './blueprint.js';
import {
  generateCodingQuestion, generateDebugQuestion, generateMcqSet, generateSqlQuestion, toBankRow,
} from './generator.js';
import { assessmentChat } from './llm.js';

/**
 * The question bank.
 *
 * Generating and verifying one coding question takes most of a minute, which is
 * not a thing to make a student watch. Nothing is written ahead of time: every
 * question in here was generated for a real attempt and kept on the way past,
 * so a problem warms itself the first time somebody sits it. Two students get
 * different papers because the draw excludes what each has already seen — and a
 * retry is a genuinely new paper for the same reason, which is the point.
 */

/** How long a question stays "already seen" for one student. */
export const EXPOSURE_HORIZON_DAYS = Number(process.env.ASSESSMENT_EXPOSURE_HORIZON_DAYS ?? 180);

export async function loadArticle(problemId) {
  const blog = unwrap(
    await db
      .from('blogs')
      .select('id, title, blocks')
      .eq('problem_id', problemId)
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    'load assessment article',
  );
  if (!blog) return null;

  const excerpt = (blog.blocks ?? [])
    .map((block) => {
      if (block.type === 'heading') return `## ${block.text}`;
      if (block.type === 'paragraph') return block.text;
      if (block.type === 'list') return (block.items ?? []).map((item) => `- ${item}`).join('\n');
      if (block.type === 'callout') return `${block.title ?? ''}: ${block.text ?? ''}`;
      if (block.type === 'table') return `${block.caption ?? ''} ${(block.headers ?? []).join(' | ')}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 3500);

  return { id: blog.id, title: blog.title, excerpt };
}

async function candidatesFor({ problemId, kind, userId }) {
  const rows = unwrap(
    await db
      .from('assessment_questions')
      .select('*')
      .eq('problem_id', problemId)
      .eq('kind', kind)
      .eq('verified', true)
      .is('retired_at', null)
      .order('times_served', { ascending: true })
      .limit(120),
    'load question bank',
  );
  if (!rows.length) return [];

  // A question seen six months ago is a fair question again. Without a horizon
  // a regular user eventually excludes everything a problem has and falls back
  // to paying for generation on every attempt, for good.
  const horizon = new Date(Date.now() - EXPOSURE_HORIZON_DAYS * 86_400_000).toISOString();
  const seen = unwrap(
    await db
      .from('assessment_exposures')
      .select('question_id')
      .eq('user_id', userId)
      .gte('first_served_at', horizon)
      .in('question_id', rows.map((row) => row.id)),
    'load question exposures',
  );
  const seenIds = new Set(seen.map((row) => row.question_id));
  return rows.filter((row) => !seenIds.has(row.id));
}

/**
 * Draws one unseen question per slot, preferring a matching concept area and
 * difficulty but never refusing a paper over it — a near-miss question the
 * student has not seen beats making them wait for a perfect one.
 */
export function chooseFromPool(pool, slot, random) {
  if (!pool.length) return null;
  const scored = pool.map((row) => ({
    row,
    score: (row.concept_area === slot.conceptArea ? 4 : 0)
      + (row.difficulty === slot.difficulty ? 2 : 0)
      + (slot.source === 'blog' ? (row.source === 'blog' ? 3 : 0) : (row.source === 'catalog' ? 1 : 0))
      - Math.min(row.times_served, 3) * 0.5
      + random(),
  }));
  scored.sort((left, right) => right.score - left.score);
  return scored[0].row;
}

export async function storeQuestions(rows) {
  if (!rows.length) return [];
  // A batch that names the same (problem, fingerprint) twice is rejected whole
  // by Postgres — "ON CONFLICT DO UPDATE cannot affect row a second time" — so
  // duplicates are collapsed here rather than costing the round.
  const unique = [...new Map(rows.map((row) => [`${row.problem_id}:${row.fingerprint}`, row])).values()];
  return unwrap(
    await db
      .from('assessment_questions')
      .upsert(unique, { onConflict: 'problem_id,fingerprint', ignoreDuplicates: false })
      .select('*'),
    'store generated questions',
  );
}

export async function recordExposures(userId, attemptId, questionIds) {
  if (!questionIds.length) return;
  unwrap(
    await db.from('assessment_exposures').upsert(
      questionIds.map((questionId) => ({ user_id: userId, question_id: questionId, attempt_id: attemptId })),
      { onConflict: 'user_id,question_id', ignoreDuplicates: true },
    ),
    'record question exposure',
  );
  // A tie-break counter is not worth failing a paper over, but a silently
  // missing function is worth knowing about.
  const counted = await Promise.all(questionIds.map((id) => db.rpc('increment_question_served', { question: id })));
  const failure = counted.find((result) => result?.error);
  if (failure) console.warn('[optimus] could not update serve counts:', failure.error.message);
}

/**
 * Generates whatever the blueprint asked for and the bank could not supply.
 * MCQ slots go in one call: it is cheaper, and it lets the model see the other
 * nine questions so it does not write the same one twice.
 */
export async function generateMissing({ problem, slots, seed, article, continueOnError = false, deps = {} }) {
  const failures = [];
  const attempt = async (label, run) => {
    if (!continueOnError) return run();
    try {
      return await run();
    } catch (error) {
      // Warming a bank is a batch job: one question that cannot verify should
      // not throw away the three beside it that did. Assembling a paper is the
      // opposite — there, a missing question means no paper.
      failures.push(`${label}: ${error.message.split('\n')[0]}`);
      return null;
    }
  };
  const chatImpl = deps.chatImpl ?? assessmentChat(problem.id);
  const generateMcqSetImpl = deps.generateMcqSetImpl
    ?? ((options) => generateMcqSet({ ...options, chatImpl }));
  const generateCodingImpl = deps.generateCodingImpl
    ?? ((options) => generateCodingQuestion({ ...options, chatImpl }));
  const generateDebugImpl = deps.generateDebugImpl
    ?? ((options) => generateDebugQuestion({ ...options, chatImpl }));
  const generateSqlImpl = deps.generateSqlImpl
    ?? ((options) => generateSqlQuestion({ ...options, chatImpl }));

  const produced = [];
  const mcqSlots = slots.filter((slot) => slot.type === 'mcq');
  if (mcqSlots.length) {
    const generated = await attempt('mcq', () => generateMcqSetImpl({
      problem,
      slots: mcqSlots,
      seed,
      article: mcqSlots.some((slot) => slot.source === 'blog') ? article : null,
    })) ?? [];
    generated.forEach((item, index) => {
      const slot = mcqSlots[index];
      produced.push({
        slot,
        generated: { ...item, meta: { ...item.meta, blogId: slot.source === 'blog' ? article?.id ?? null : null } },
      });
    });
  }

  // Machine coding first: a debug question on the same paper is built from it,
  // which is both cheaper and far more likely to survive verification.
  const ordered = slots.filter((slot) => slot.type !== 'mcq')
    .sort((left, right) => Number(left.type === 'debug') - Number(right.type === 'debug'));
  let base = null;

  for (const slot of ordered) {
    if (slot.type === 'sql') {
      const generated = await attempt('sql', () => generateSqlImpl({ problem, slot, seed }));
      if (generated) produced.push({ slot, generated });
      continue;
    }
    if (slot.type === 'debug') {
      const source = base ?? await verifiedBase(problem.id);
      // A debug exercise is a broken copy of a verified question. With none to
      // hand, generating a fresh one here would just repeat the machine-coding
      // attempt that failed a moment ago — leave it for the next round.
      if (!source && continueOnError) {
        failures.push('debug: no verified machine-coding question to break yet');
        continue;
      }
      const generated = await attempt('debug', () => generateDebugImpl({ problem, slot, seed, base: source }));
      if (generated) produced.push({ slot, generated });
      continue;
    }
    const generated = await attempt('machine_coding', () => generateCodingImpl({ problem, slot, seed }));
    if (generated) {
      base = generated.question;
      produced.push({ slot, generated });
    }
  }

  produced.failures = failures;
  return produced;
}

/** Any already-verified machine-coding question for this problem can seed a debug exercise. */
async function verifiedBase(problemId) {
  const row = unwrap(
    await db
      .from('assessment_questions')
      .select('payload')
      .eq('problem_id', problemId)
      .eq('kind', 'machine_coding')
      .eq('verified', true)
      .is('retired_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    'load a base question for debugging',
  );
  return row?.payload ?? null;
}

/**
 * The draw that opens an exam. Reads only — it never generates.
 *
 * `limit` bounds what the click path is allowed to spend before it answers, not
 * what the paper may take from the bank overall: the slots left over go through
 * `assembleSlot` in the background, which checks the bank again before writing
 * anything new. So a warm problem still costs one query per kind and no model
 * call, while the student sees question one in the time it takes to SELECT.
 */
export async function drawFromBank({ problem, blueprint, userId, limit }) {
  const random = seededRandom(`${userId}:${problem.id}:${blueprint.seed}`);
  const pools = new Map();
  const filled = new Map();

  for (const slot of blueprint.slots) {
    if (filled.size >= limit) break;
    if (!pools.has(slot.type)) {
      pools.set(slot.type, await candidatesFor({ problemId: problem.id, kind: slot.type, userId }));
    }
    const pool = pools.get(slot.type);
    const chosen = chooseFromPool(pool, slot, random);
    if (!chosen) continue;
    // Without replacement: one bank row cannot fill two slots on one paper.
    pools.set(slot.type, pool.filter((row) => row.id !== chosen.id));
    filled.set(slot.id, { slot, row: chosen });
  }

  return {
    entries: blueprint.slots.map((slot) => filled.get(slot.id)).filter(Boolean),
    missing: blueprint.slots.filter((slot) => !filled.has(slot.id)),
  };
}

/**
 * Assemble a single slot for progressive delivery.
 *
 * The paper is still selected from the verified bank first. Only when that
 * pool is empty do we generate and verify one question. Keeping this unit of
 * work small lets the assessment expose its first question while the rest of
 * the paper is prepared in the background.
 */
export async function assembleSlot({ problem, blueprint, userId, article, slot, usedQuestionIds = [], deps = {} }) {
  const random = seededRandom(`${userId}:${problem.id}:${blueprint.seed}:${slot.id}`);
  const pool = (await candidatesFor({ problemId: problem.id, kind: slot.type, userId }))
    .filter((row) => !usedQuestionIds.includes(row.id));
  const chosen = chooseFromPool(pool, slot, random);
  if (chosen) return { slot, row: chosen };

  const produced = await generateMissing({
    problem,
    slots: [slot],
    seed: `${blueprint.seed}:${slot.id}`,
    article,
    // Optional debug questions may be unavailable until a verified coding
    // question exists. They are safely dropped and their weight is moved at
    // the end of assembly.
    continueOnError: Boolean(slot.optional),
    deps,
  });
  if (!produced.length) return null;

  const stored = await storeQuestions(produced.map(({ generated }) => toBankRow({ problem, generated })));
  const generated = produced[0];
  const row = stored.find((candidate) => candidate.fingerprint === toBankRow({ problem, generated: generated.generated }).fingerprint);
  return row ? { slot, row } : null;
}

/**
 * A dropped slot's marks go to the remaining work rather than shrinking the
 * paper — 80% has to mean the same thing whether or not the debug question
 * could be written.
 */
export function redistribute(ordered, dropped) {
  const lost = dropped.reduce((total, slot) => total + slot.weight, 0);
  if (!lost || !ordered.length) return ordered;

  const heaviest = ordered.reduce((best, entry) => (entry.slot.weight > best.slot.weight ? entry : best), ordered[0]);
  return ordered.map((entry) => (entry === heaviest
    ? { ...entry, slot: { ...entry.slot, weight: entry.slot.weight + lost } }
    : entry));
}

/**
 * What the bank holds per problem and kind.
 *
 * Now that supply is demand-driven, this is the number that predicts how long
 * the next student waits — so it is an operational metric rather than a target
 * some job is chasing.
 */
export async function bankInventory(problemIds) {
  if (!problemIds.length) return new Map();
  const rows = unwrap(
    await db
      .from('assessment_questions')
      .select('problem_id, kind')
      .in('problem_id', problemIds)
      .eq('verified', true)
      .is('retired_at', null),
    'measure question bank',
  );
  const inventory = new Map();
  for (const row of rows) {
    const depth = inventory.get(row.problem_id) ?? {};
    depth[row.kind] = (depth[row.kind] ?? 0) + 1;
    inventory.set(row.problem_id, depth);
  }
  return inventory;
}
