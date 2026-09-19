import { env } from '../../config/env.js';
import { db, unwrap } from '../../lib/supabase.js';
import { getProblemById } from '../problem-catalog.service.js';
import { resumeGeneratingAssessments, settlePendingGrades } from '../assessment.service.js';
import { planBlueprint } from './blueprint.js';
import {
  LOW_WATER, bankDepth, generateMissing, loadArticle, storeQuestions,
} from './bank.js';
import { toBankRow } from './generator.js';

/**
 * Keeps assessments answerable without anyone waiting.
 *
 * Two jobs, both deliberately small per tick. It finishes any paper whose
 * grading was cut short by a runner outage — a student must never lose a day
 * because a shared judge was down — and it tops up the thinnest question bank by
 * exactly one question. One at a time is the point: generation is the heaviest
 * user of the code runner we share with live students, and there is no deadline.
 */

const TOP_UP_PER_TICK = 1;
const RECENT_DAYS = 45;

async function recentlyAssessedProblems() {
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString();
  const rows = unwrap(
    await db
      .from('assessment_attempts')
      .select('problem_id, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(400),
    'load recently assessed problems',
  );
  return [...new Set(rows.map((row) => row.problem_id))];
}

/**
 * The slot type a problem is shortest on, or null when it is well stocked.
 * A problem that is not coded needs no coding bank.
 */
export function thinnestKind(depth, problem) {
  const wanted = problem.kind === 'LLD' && problem.coding_enabled !== false
    ? ['machine_coding', 'debug', 'mcq']
    : ['mcq'];
  const shortfalls = wanted
    .map((type) => ({ type, have: depth[type] ?? 0 }))
    .filter((entry) => entry.have < LOW_WATER)
    .sort((left, right) => left.have - right.have);
  return shortfalls[0]?.type ?? null;
}

export async function topUpOnce() {
  const problemIds = await recentlyAssessedProblems();
  for (const problemId of problemIds) {
    const problem = await getProblemById(problemId, '*', ['LLD', 'HLD']);
    if (!problem?.assessment_enabled) continue;

    const depth = await bankDepth(problemId);
    const kind = thinnestKind(depth, problem);
    if (!kind) continue;

    // Borrow a blueprint purely for a well-formed slot of the type we need.
    const blueprint = planBlueprint({
      problem,
      userId: 'bank-worker',
      attemptNumber: Date.now() % 100_000,
      blogAvailable: false,
    });
    const slot = blueprint.slots.find((entry) => entry.type === kind)
      ?? { id: 'bank', type: kind, conceptArea: 'implementing the design', difficulty: problem.difficulty, weight: 1, source: 'catalog', language: 'python', bugCount: 1, minutes: 30 };

    const article = slot.source === 'blog' ? await loadArticle(problemId) : null;
    const produced = await generateMissing({ problem, slots: [slot], seed: blueprint.seed, article, continueOnError: true });
    const stored = await storeQuestions(produced.map(({ generated }) => toBankRow({ problem, generated })));
    return { problemId, kind, added: stored.length, discarded: (produced.failures ?? []).length };
  }
  return null;
}

export function startAssessmentWorker({ intervalMs = env.assessment.workerIntervalMs } = {}) {
  if (!env.ai.enabled) {
    console.log('[optimus] assessment worker idle: no LLM configured');
    return () => {};
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const resumed = await resumeGeneratingAssessments();
      if (resumed) console.log(`[optimus] resumed ${resumed} generating assessment(s)`);

      const settled = await settlePendingGrades();
      if (settled) console.log(`[optimus] settled ${settled} interrupted assessment(s)`);

      if (env.assessment.bankTopUp) {
        for (let index = 0; index < TOP_UP_PER_TICK; index += 1) {
          const result = await topUpOnce();
          if (!result) break;
          console.log(`[optimus] banked ${result.added} ${result.kind} question(s) for ${result.problemId}`);
        }
      }
    } catch (error) {
      console.error('[optimus] assessment worker tick failed:', error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 1_000).unref?.();
  return () => clearInterval(timer);
}
