import { db, unwrap } from '../../lib/supabase.js';
import { seededRandom } from './blueprint.js';
import {
  generateCodingQuestion, generateDebugQuestion, generateMcqSet, generateSqlQuestion, toBankRow,
} from './generator.js';

/**
 * The question bank.
 *
 * Generating and verifying one coding question takes most of a minute, which is
 * not a thing to make a student watch. So questions are written ahead of time,
 * kept per problem, and drawn at assembly. Two students get different papers
 * because the draw excludes what each has already seen — and a retry is a
 * genuinely new paper for the same reason, which is the point of retrying.
 */

/** Below this many unseen questions for a slot type, the worker tops the problem up. */
export const LOW_WATER = 12;
export const TARGET_DEPTH = 24;

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

  const seen = unwrap(
    await db
      .from('assessment_exposures')
      .select('question_id')
      .eq('user_id', userId)
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
  const {
    generateMcqSetImpl = generateMcqSet,
    generateCodingImpl = generateCodingQuestion,
    generateDebugImpl = generateDebugQuestion,
    generateSqlImpl = generateSqlQuestion,
  } = deps;

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
 * Assembles a paper: bank first, generation for the rest.
 * Returns the ordered questions with the bank row ids that produced them.
 */
export async function assemblePaper({ problem, blueprint, userId, article, deps = {} }) {
  const random = seededRandom(`${userId}:${problem.id}:${blueprint.seed}`);
  const pools = new Map();
  const filled = new Map();
  const missing = [];

  for (const slot of blueprint.slots) {
    if (!pools.has(slot.type)) {
      pools.set(slot.type, await candidatesFor({ problemId: problem.id, kind: slot.type, userId }));
    }
    const pool = pools.get(slot.type);
    const chosen = chooseFromPool(pool, slot, random);
    if (chosen) {
      // Without replacement: one bank row cannot fill two slots on one paper.
      pools.set(slot.type, pool.filter((row) => row.id !== chosen.id));
      filled.set(slot.id, { slot, row: chosen });
    } else {
      missing.push(slot);
    }
  }

  if (missing.length) {
    // An optional slot that cannot be filled is dropped, not fatal.
    const produced = await generateMissing({
      problem, slots: missing, seed: blueprint.seed, article, deps,
      continueOnError: missing.every((slot) => slot.optional) || missing.some((slot) => slot.optional),
    });
    const stored = await storeQuestions(produced.map(({ generated }) => toBankRow({ problem, generated })));
    const byFingerprint = new Map(stored.map((row) => [row.fingerprint, row]));
    for (const { slot, generated } of produced) {
      const row = byFingerprint.get(toBankRow({ problem, generated }).fingerprint);
      if (row) filled.set(slot.id, { slot, row });
    }
  }

  const ordered = blueprint.slots.map((slot) => filled.get(slot.id)).filter(Boolean);
  const dropped = blueprint.slots.filter((slot) => !filled.has(slot.id));
  if (dropped.some((slot) => !slot.optional)) {
    throw new Error(`Assembled ${ordered.length} of ${blueprint.slots.length} questions`);
  }
  return redistribute(ordered, dropped);
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

/** How many unseen-by-anyone questions each slot type has for a problem. */
export async function bankDepth(problemId) {
  const rows = unwrap(
    await db
      .from('assessment_questions')
      .select('kind')
      .eq('problem_id', problemId)
      .eq('verified', true)
      .is('retired_at', null),
    'measure question bank',
  );
  return rows.reduce((depth, row) => ({ ...depth, [row.kind]: (depth[row.kind] ?? 0) + 1 }), {});
}
