import { env } from '../../config/env.js';
import { resumeIncompleteAssessments, settlePendingGrades } from '../assessment.service.js';

/**
 * Crash recovery for assessments. Nothing else.
 *
 * There is no bank to warm: every question is written for a real attempt and
 * kept on the way past, so supply follows demand without a job chasing it. What
 * remains are the two things a restart or an outage can strand — a paper whose
 * fill was interrupted, and a paper whose grading was cut short by the judge
 * being down. A student must never lose a day to either.
 */

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
      const resumed = await resumeIncompleteAssessments();
      if (resumed) console.log(`[optimus] resumed ${resumed} unfinished assessment(s)`);

      const settled = await settlePendingGrades();
      if (settled) console.log(`[optimus] settled ${settled} interrupted assessment(s)`);
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
