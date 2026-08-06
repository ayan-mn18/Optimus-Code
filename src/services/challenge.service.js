import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { todayIn, addDays, daysBetween } from '../lib/dates.js';

const PROBLEM_FIELDS = 'id, slug, title, topic, difficulty, leetcode_url, youtube_url, article_url, order_index';

/** Fraction of a daily set reserved for problems returning from a red day. */
const BACKLOG_SHARE = 0.6;

/** Guard on extra sets, so a day cannot be extended without limit. */
const MAX_ROUNDS_PER_DAY = 5;

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function getEnrollment(userId) {
  return unwrap(
    await db.from('enrollments').select('*').eq('user_id', userId).maybeSingle(),
    'load enrollment',
  );
}

export async function enroll(userId, { dailyTarget = env.dailyTarget, timezone }) {
  const existing = await getEnrollment(userId);
  if (existing) {
    return unwrap(
      await db
        .from('enrollments')
        .update({ daily_target: dailyTarget, status: 'active' })
        .eq('id', existing.id)
        .select('*')
        .single(),
      'update enrollment',
    );
  }

  return unwrap(
    await db
      .from('enrollments')
      .insert({ user_id: userId, daily_target: dailyTarget, started_on: todayIn(timezone) })
      .select('*')
      .single(),
    'create enrollment',
  );
}

async function requireEnrollment(userId) {
  const enrollment = await getEnrollment(userId);
  if (!enrollment) {
    throw ApiError.forbidden('Join the daily challenge first');
  }
  return enrollment;
}

/**
 * Settles every day that ended without being closed out. A day where the user
 * fell short of the target becomes a red day; its unsolved problems simply stop
 * being "assigned today" and flow back into the pool as backlog.
 */
async function closeOpenDays(userId, today) {
  const openLogs = unwrap(
    await db
      .from('daily_logs')
      .select('id, log_date, required_count')
      .eq('user_id', userId)
      .eq('status', 'active')
      .lt('log_date', today),
    'load open days',
  );

  if (!openLogs.length) return [];

  const dates = openLogs.map((log) => log.log_date);
  // Round 1 only — a day is judged on its target set, never on extra sets the
  // user asked for after clearing it.
  const assignments = unwrap(
    await db
      .from('daily_assignments')
      .select('problem_id, assigned_on')
      .eq('user_id', userId)
      .eq('round', 1)
      .in('assigned_on', dates),
    'load assignments for open days',
  );

  const solvedIds = await getSolvedProblemIds(userId);
  const closed = [];

  for (const log of openLogs) {
    const dayProblems = assignments.filter((a) => a.assigned_on === log.log_date);
    const solved = dayProblems.filter((a) => solvedIds.has(a.problem_id)).length;
    const status = solved >= log.required_count ? 'complete' : 'missed';

    unwrap(
      await db
        .from('daily_logs')
        .update({ solved_count: solved, status, closed_at: new Date().toISOString() })
        .eq('id', log.id),
      'close day',
    );

    closed.push({ date: log.log_date, status, solved });
  }

  return closed;
}

async function getSolvedProblemIds(userId) {
  const rows = unwrap(
    await db.from('user_problems').select('problem_id').eq('user_id', userId).eq('status', 'solved'),
    'load solved problems',
  );
  return new Set(rows.map((row) => row.problem_id));
}

/**
 * Picks the day's set: a few problems carried over from red days, the rest
 * fresh, all from different topics wherever the remaining pool allows it.
 */
async function pickDailyProblems(userId, today, target) {
  const [problems, assignments, solvedIds] = await Promise.all([
    unwrap(await db.from('problems').select(PROBLEM_FIELDS).order('order_index'), 'load problems'),
    unwrap(
      await db.from('daily_assignments').select('problem_id, assigned_on').eq('user_id', userId),
      'load past assignments',
    ),
    getSolvedProblemIds(userId),
  ]);

  const byId = new Map(problems.map((p) => [p.id, p]));

  // Oldest unsolved assignment per problem — these are the red-day leftovers.
  const firstAssigned = new Map();
  for (const a of assignments) {
    const prev = firstAssigned.get(a.problem_id);
    if (!prev || a.assigned_on < prev) firstAssigned.set(a.problem_id, a.assigned_on);
  }

  const backlog = [...firstAssigned.entries()]
    .filter(([problemId, date]) => date < today && !solvedIds.has(problemId) && byId.has(problemId))
    .sort((a, b) => (a[1] < b[1] ? -1 : 1))
    .map(([problemId]) => ({ problem: byId.get(problemId), carriedOver: true }));

  const fresh = shuffle(
    problems
      .filter((p) => !solvedIds.has(p.id) && !firstAssigned.has(p.id))
      .map((problem) => ({ problem, carriedOver: false })),
  );

  // Bias the fresh picks toward topics the user has touched least.
  const solvedPerTopic = new Map();
  for (const p of problems) {
    if (solvedIds.has(p.id)) solvedPerTopic.set(p.topic, (solvedPerTopic.get(p.topic) ?? 0) + 1);
  }
  fresh.sort((a, b) => (solvedPerTopic.get(a.problem.topic) ?? 0) - (solvedPerTopic.get(b.problem.topic) ?? 0));

  const backlogQuota = Math.min(backlog.length, Math.ceil(target * BACKLOG_SHARE));
  const ordered = [...backlog.slice(0, backlogQuota), ...fresh, ...backlog.slice(backlogQuota)];

  // Pass 1: one problem per topic. Pass 2: fill any gap, topics repeat.
  const picked = [];
  const usedTopics = new Set();
  const takenIds = new Set();

  for (const candidate of ordered) {
    if (picked.length >= target) break;
    if (usedTopics.has(candidate.problem.topic)) continue;
    picked.push(candidate);
    usedTopics.add(candidate.problem.topic);
    takenIds.add(candidate.problem.id);
  }

  for (const candidate of ordered) {
    if (picked.length >= target) break;
    if (takenIds.has(candidate.problem.id)) continue;
    picked.push(candidate);
    takenIds.add(candidate.problem.id);
  }

  return shuffle(picked);
}

/** Recomputes solved/bonus counts for a day and flips it green once the target is hit. */
async function refreshDayCounters(userId, date) {
  const log = unwrap(
    await db.from('daily_logs').select('*').eq('user_id', userId).eq('log_date', date).maybeSingle(),
    'load day log',
  );
  if (!log) return null;

  const [assignments, solvedToday] = await Promise.all([
    unwrap(
      await db
        .from('daily_assignments')
        .select('problem_id, round')
        .eq('user_id', userId)
        .eq('assigned_on', date)
        .eq('round', 1),
      'load day assignments',
    ),
    unwrap(
      await db
        .from('user_problems')
        .select('problem_id')
        .eq('user_id', userId)
        .eq('status', 'solved')
        .eq('solved_on', date),
      'load solves for day',
    ),
  ]);

  // Only round 1 counts toward the target. Everything else solved today —
  // extra sets the user asked for, or problems picked freely from the
  // library — lands in the bonus tally.
  const targetSetIds = new Set(assignments.map((a) => a.problem_id));
  const solvedIds = solvedToday.map((row) => row.problem_id);
  const solvedCount = solvedIds.filter((id) => targetSetIds.has(id)).length;
  const bonusCount = solvedIds.filter((id) => !targetSetIds.has(id)).length;

  const status = solvedCount >= log.required_count
    ? 'complete'
    : log.status === 'missed'
      ? 'missed'
      : 'active';

  return unwrap(
    await db
      .from('daily_logs')
      .update({
        solved_count: solvedCount,
        bonus_count: bonusCount,
        status,
        closed_at: status === 'complete' ? new Date().toISOString() : log.closed_at,
      })
      .eq('id', log.id)
      .select('*')
      .single(),
    'update day counters',
  );
}

/**
 * The main entry point for the dashboard: settles stale days, then returns
 * today's set — generating it on first visit of the day.
 */
export async function getToday(user) {
  const enrollment = await requireEnrollment(user.id);
  const today = todayIn(user.timezone);

  const closedDays = await closeOpenDays(user.id, today);

  let log = unwrap(
    await db.from('daily_logs').select('*').eq('user_id', user.id).eq('log_date', today).maybeSingle(),
    'load today log',
  );

  if (!log) {
    const picks = await pickDailyProblems(user.id, today, enrollment.daily_target);

    log = unwrap(
      await db
        .from('daily_logs')
        .insert({ user_id: user.id, log_date: today, required_count: picks.length || enrollment.daily_target })
        .select('*')
        .single(),
      'create today log',
    );

    if (picks.length) {
      unwrap(
        await db.from('daily_assignments').insert(
          picks.map((pick, index) => ({
            user_id: user.id,
            problem_id: pick.problem.id,
            assigned_on: today,
            position: index,
            carried_over: pick.carriedOver,
          })),
        ),
        'create today assignments',
      );
    }
  }

  const assignments = unwrap(
    await db
      .from('daily_assignments')
      .select(`position, round, carried_over, problem:problems(${PROBLEM_FIELDS})`)
      .eq('user_id', user.id)
      .eq('assigned_on', today)
      .order('round')
      .order('position'),
    'load today assignments',
  );

  const solvedRows = unwrap(
    await db
      .from('user_problems')
      .select('problem_id, solved_on, is_bonus, time_spent_min')
      .eq('user_id', user.id)
      .eq('status', 'solved'),
    'load solved rows',
  );
  const solvedMap = new Map(solvedRows.map((row) => [row.problem_id, row]));

  log = (await refreshDayCounters(user.id, today)) ?? log;

  // Free picks from the library. Extra-set solves are also flagged bonus, but
  // they already have their own section, so they are excluded here rather than
  // being listed on the dashboard twice.
  const assignedTodayIds = new Set(assignments.map((row) => row.problem.id));
  const bonusSolves = unwrap(
    await db
      .from('user_problems')
      .select(`solved_on, is_bonus, problem:problems(${PROBLEM_FIELDS})`)
      .eq('user_id', user.id)
      .eq('solved_on', today)
      .eq('is_bonus', true),
    'load bonus solves',
  ).filter((row) => !assignedTodayIds.has(row.problem.id));

  return {
    date: today,
    timezone: user.timezone,
    target: log.required_count,
    solvedCount: log.solved_count,
    bonusCount: log.bonus_count,
    status: log.status,
    isComplete: log.status === 'complete',
    closedDays,
    problems: assignments.filter((row) => row.round === 1).map(toProblem(solvedMap)),
    // Extra sets dealt after the target was met, newest last.
    extraSets: [...new Set(assignments.filter((row) => row.round > 1).map((row) => row.round))]
      .sort((a, b) => a - b)
      .map((round) => ({
        round,
        problems: assignments.filter((row) => row.round === round).map(toProblem(solvedMap)),
      })),
    canExtend: log.status === 'complete' && maxRound(assignments) < MAX_ROUNDS_PER_DAY,
    bonusProblems: bonusSolves.map((row) => ({ ...row.problem, solved: true, solvedOn: row.solved_on })),
  };
}

const toProblem = (solvedMap) => (row) => ({
  ...row.problem,
  position: row.position,
  round: row.round,
  carriedOver: row.carried_over,
  solved: solvedMap.has(row.problem.id),
  solvedOn: solvedMap.get(row.problem.id)?.solved_on ?? null,
});

const maxRound = (assignments) => assignments.reduce((max, row) => Math.max(max, row.round), 1);

/**
 * Deals another set once the day's target is met — the alternative to wandering
 * off into the full library. Extra sets never change the target, so the day
 * stays green no matter how much of the extra set gets solved.
 */
export async function extendToday(user) {
  const enrollment = await requireEnrollment(user.id);
  const today = todayIn(user.timezone);

  await closeOpenDays(user.id, today);

  const log = unwrap(
    await db.from('daily_logs').select('*').eq('user_id', user.id).eq('log_date', today).maybeSingle(),
    'load today log',
  );

  if (!log || log.status !== 'complete') {
    throw ApiError.badRequest('Finish today\'s set before asking for another one');
  }

  const existing = unwrap(
    await db.from('daily_assignments').select('round').eq('user_id', user.id).eq('assigned_on', today),
    'load today rounds',
  );

  const nextRound = maxRound(existing) + 1;
  if (nextRound > MAX_ROUNDS_PER_DAY) {
    throw ApiError.badRequest(`That is ${MAX_ROUNDS_PER_DAY} sets today. Pick freely from all problems instead`);
  }

  const picks = await pickDailyProblems(user.id, today, enrollment.daily_target);
  if (!picks.length) {
    throw ApiError.badRequest('Nothing left unsolved — you have finished the sheet');
  }

  unwrap(
    await db.from('daily_assignments').insert(
      picks.map((pick, index) => ({
        user_id: user.id,
        problem_id: pick.problem.id,
        assigned_on: today,
        position: index,
        round: nextRound,
        carried_over: pick.carriedOver,
      })),
    ),
    'create extra set',
  );

  return getToday(user);
}

export async function markSolved(user, problemId, { timeSpentMin = null, notes = null } = {}) {
  await requireEnrollment(user.id);
  const today = todayIn(user.timezone);

  const problem = unwrap(
    await db.from('problems').select(PROBLEM_FIELDS).eq('id', problemId).maybeSingle(),
    'load problem',
  );
  if (!problem) throw ApiError.notFound('Problem not found');

  await closeOpenDays(user.id, today);

  // Only the target set counts as non-bonus — problems from an extra set are
  // bonus just like ones picked freely from the library.
  const inTargetSet = unwrap(
    await db
      .from('daily_assignments')
      .select('id')
      .eq('user_id', user.id)
      .eq('assigned_on', today)
      .eq('round', 1)
      .eq('problem_id', problemId)
      .maybeSingle(),
    'check today assignment',
  );

  unwrap(
    await db.from('user_problems').upsert(
      {
        user_id: user.id,
        problem_id: problemId,
        status: 'solved',
        solved_on: today,
        is_bonus: !inTargetSet,
        time_spent_min: timeSpentMin,
        notes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,problem_id' },
    ),
    'mark problem solved',
  );

  const log = await refreshDayCounters(user.id, today);

  return {
    problem: { ...problem, solved: true, solvedOn: today },
    isBonus: !inTargetSet,
    day: log && {
      date: today,
      target: log.required_count,
      solvedCount: log.solved_count,
      bonusCount: log.bonus_count,
      status: log.status,
      isComplete: log.status === 'complete',
    },
    streak: await getStreak(user),
  };
}

export async function unmarkSolved(user, problemId) {
  const today = todayIn(user.timezone);

  unwrap(
    await db.from('user_problems').delete().eq('user_id', user.id).eq('problem_id', problemId),
    'unmark problem',
  );

  const log = await refreshDayCounters(user.id, today);
  return { problemId, day: log, streak: await getStreak(user) };
}

/** Current and longest run of green days. Today still being open never breaks it. */
export async function getStreak(user) {
  const today = todayIn(user.timezone);
  const logs = unwrap(
    await db
      .from('daily_logs')
      .select('log_date, status')
      .eq('user_id', user.id)
      .order('log_date', { ascending: false }),
    'load logs for streak',
  );

  const statusByDate = new Map(logs.map((log) => [log.log_date, log.status]));

  let current = 0;
  let cursor = statusByDate.get(today) === 'complete' ? today : addDays(today, -1);
  while (statusByDate.get(cursor) === 'complete') {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  let longest = 0;
  let run = 0;
  let previous = null;
  const ascending = [...logs].reverse();
  for (const log of ascending) {
    if (log.status !== 'complete') {
      run = 0;
      previous = log.log_date;
      continue;
    }
    run = previous && daysBetween(previous, log.log_date) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = log.log_date;
  }

  return {
    current,
    longest,
    greenDays: logs.filter((log) => log.status === 'complete').length,
    redDays: logs.filter((log) => log.status === 'missed').length,
  };
}
