import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';
import { daysBetween } from '../lib/dates.js';
import { getStreak } from './challenge.service.js';

export const MILESTONE_STEP = 50;

const UNIQUE_VIOLATION = '23505';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function reachedMilestone(solvedCount) {
  return Math.floor(solvedCount / MILESTONE_STEP) * MILESTONE_STEP;
}

/** Builds the immutable, share-safe snapshot shown in the milestone recap. */
export function analyzeMilestone({ user, milestone, solves, streak, dailyTarget }) {
  if (solves.length < milestone) throw new Error(`Milestone ${milestone} requires ${milestone} solves`);

  const milestoneSolves = solves.slice(0, milestone);
  const byTopic = new Map();
  const byDate = new Map();
  const byWeekday = new Map();
  const difficulty = { Easy: 0, Medium: 0, Hard: 0 };
  let bonus = 0;
  let trackedMinutes = 0;

  for (const solve of milestoneSolves) {
    if (solve.problem) {
      byTopic.set(solve.problem.topic, (byTopic.get(solve.problem.topic) ?? 0) + 1);
      difficulty[solve.problem.difficulty] = (difficulty[solve.problem.difficulty] ?? 0) + 1;
    }
    byDate.set(solve.solved_on, (byDate.get(solve.solved_on) ?? 0) + 1);
    const weekday = WEEKDAYS[new Date(`${solve.solved_on}T00:00:00Z`).getUTCDay()];
    byWeekday.set(weekday, (byWeekday.get(weekday) ?? 0) + 1);
    if (solve.is_bonus) bonus += 1;
    if (solve.time_spent_min) trackedMinutes += solve.time_spent_min;
  }

  const ranked = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topTopics = ranked(byTopic).slice(0, 3).map(([topic, count]) => ({ topic, count }));
  const [bestDate, bestDateCount] = ranked(byDate)[0] ?? [null, 0];
  const [strongestDay, strongestDayCount] = ranked(byWeekday)[0] ?? [null, 0];
  const firstSolvedOn = milestoneSolves[0].solved_on;
  const achievedOn = milestoneSolves.at(-1).solved_on;
  const activeDays = byDate.size;
  const spanDays = Math.max(daysBetween(firstSolvedOn, achievedOn) + 1, 1);
  const averagePerActiveDay = Number((milestone / Math.max(activeDays, 1)).toFixed(1));
  const weeklyPace = Number(((milestone / spanDays) * 7).toFixed(1));
  const recommendedDaily = dailyTarget ?? Math.max(1, Math.min(8, Math.round(weeklyPace / 7) || 3));
  const topTopic = topTopics[0];

  let headline = `${activeDays} active days built this milestone.`;
  if (difficulty.Hard >= milestone * 0.35) headline = 'Hard problems did not slow you down.';
  else if (topTopic && topTopic.count >= milestone * 0.25) headline = `${topTopic.topic} became your home ground.`;
  else if (bonus >= milestone * 0.3) headline = 'You kept going after the target.';

  return {
    milestone,
    nextMilestone: milestone + MILESTONE_STEP,
    achievedOn,
    user: { name: user.name, avatarSeed: user.avatar_seed },
    headline,
    totals: {
      solved: milestone,
      activeDays,
      bonus,
      topicsTouched: byTopic.size,
      trackedMinutes,
    },
    topTopics,
    difficulty,
    rhythm: {
      firstSolvedOn,
      bestDate,
      bestDateCount,
      strongestDay,
      strongestDayCount,
      averagePerActiveDay,
      weeklyPace,
    },
    streak: {
      current: streak.current,
      longest: streak.longest,
      greenDays: streak.greenDays,
    },
    recommendation: {
      daily: recommendedDaily,
      remaining: MILESTONE_STEP,
      projectedDays: Math.ceil(MILESTONE_STEP / recommendedDaily),
    },
  };
}

async function solvedCount(userId) {
  const { count, error } = await db
    .from('user_problems')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'solved');

  if (error) throw Object.assign(new Error(`count milestone solves: ${error.message}`), { status: 500 });
  return count ?? 0;
}

async function loadRecap(user, milestone) {
  const [solves, enrollment, streak] = await Promise.all([
    unwrap(
      await db
        .from('user_problems')
        .select('solved_on, is_bonus, time_spent_min, created_at, problem:problems(topic, difficulty)')
        .eq('user_id', user.id)
        .eq('status', 'solved')
        .order('solved_on', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(milestone),
      'load milestone solves',
    ),
    unwrap(
      await db.from('enrollments').select('daily_target').eq('user_id', user.id).maybeSingle(),
      'load milestone target',
    ),
    getStreak(user),
  ]);

  return analyzeMilestone({
    user,
    milestone,
    solves,
    streak,
    dailyTarget: enrollment?.daily_target,
  });
}

export async function getPendingMilestone(user) {
  const milestone = reachedMilestone(await solvedCount(user.id));
  if (milestone < MILESTONE_STEP) return null;

  const existing = unwrap(
    await db
      .from('milestone_recaps')
      .select('snapshot, viewed_at')
      .eq('user_id', user.id)
      .eq('milestone', milestone)
      .maybeSingle(),
    'load milestone recap',
  );
  if (existing) return existing.viewed_at ? null : existing.snapshot;

  const snapshot = await loadRecap(user, milestone);
  const created = await db.from('milestone_recaps').insert({
    user_id: user.id,
    milestone,
    achieved_on: snapshot.achievedOn,
    snapshot,
  });

  if (created.error && created.error.code !== UNIQUE_VIOLATION) {
    throw Object.assign(new Error(`create milestone recap: ${created.error.message}`), { status: 500 });
  }
  if (!created.error) return snapshot;

  const winner = unwrap(
    await db
      .from('milestone_recaps')
      .select('snapshot, viewed_at')
      .eq('user_id', user.id)
      .eq('milestone', milestone)
      .single(),
    'load concurrent milestone recap',
  );
  return winner.viewed_at ? null : winner.snapshot;
}

export async function markMilestoneViewed(userId, milestone) {
  const recap = unwrap(
    await db
      .from('milestone_recaps')
      .update({ viewed_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('milestone', milestone)
      .select('id')
      .maybeSingle(),
    'mark milestone viewed',
  );

  if (!recap) throw ApiError.notFound('Milestone recap not found');
}
