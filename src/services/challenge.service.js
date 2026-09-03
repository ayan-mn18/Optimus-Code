import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';
import { todayIn, addDays, daysBetween } from '../lib/dates.js';
import { sendRedDayNotification } from './notification.service.js';

const PROBLEM_FIELDS = [
  'id', 'slug', 'title', 'kind', 'topic', 'subtopic', 'difficulty', 'description',
  'leetcode_url', 'youtube_url', 'article_url', 'practice_url', 'source_url',
  'resource_metadata', 'assessment_enabled', 'coding_enabled', 'order_index',
].join(', ');

/** Fraction of a daily set reserved for problems returning from a red day. */
const BACKLOG_SHARE = 0.6;
const KINDS = ['DSA', 'LLD', 'HLD'];

const enrollmentTargets = (enrollment) => ({
  DSA: enrollment.dsa_target,
  LLD: enrollment.lld_target,
  HLD: enrollment.hld_target,
});

export function quotaComplete(log) {
  return KINDS.every((kind) => {
    const prefix = kind.toLowerCase();
    return Number(log[`${prefix}_solved`] ?? 0) >= Number(log[`${prefix}_required`] ?? 0);
  });
}
export function normalizeDailyTarget(value, kind = 'DSA') {
  const target = Number(value);
  if (!Number.isInteger(target) || target < 0 || target > 20) {
    throw ApiError.badRequest(`Invalid ${kind} daily target`);
  }
  return target;
}

function targetTotal(log) {
  return Number(log.dsa_required ?? 0) + Number(log.lld_required ?? 0) + Number(log.hld_required ?? 0);
}


const UNIQUE_VIOLATION = '23505';

/** Green days needed to earn one freeze, and the most you can bank. */
export const FREEZE_EVERY = 10;
export const FREEZE_CAP = 3;

/**
 * Freezes are derived, never incremented: earned is a pure function of green
 * days, and only the spent count is stored. An award cannot fire twice.
 */
export function freezeBalance({ greenDays, freezesUsed }) {
  const earned = Math.floor(greenDays / FREEZE_EVERY);
  return {
    earned,
    used: freezesUsed,
    available: Math.max(0, Math.min(earned - freezesUsed, FREEZE_CAP)),
    nextAt: (Math.floor(greenDays / FREEZE_EVERY) + 1) * FREEZE_EVERY,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads back a day another request is in the middle of creating, giving it a
 * moment to finish writing its assignments before we render an empty set.
 */
async function waitForDay(userId, date, attempts = 5) {
  let log = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    log = unwrap(
      await db.from('daily_logs').select('*').eq('user_id', userId).eq('log_date', date).maybeSingle(),
      'load today log',
    );

    const { count } = await db
      .from('daily_assignments')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('assigned_on', date);

    if (log && count) return log;
    await sleep(80);
  }

  return log;
}

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

export async function enroll(userId, { goals, timezone }) {
  const targets = {
    dsa_target: goals.DSA,
    lld_target: goals.LLD,
    hld_target: goals.HLD,
  };
  const existing = await getEnrollment(userId);
  if (existing) {
    return unwrap(
      await db
        .from('enrollments')
        .update({ ...targets, status: 'active' })
        .eq('id', existing.id)
        .select('*')
        .single(),
      'update enrollment',
    );
  }

  return unwrap(
    await db
      .from('enrollments')
      .insert({ user_id: userId, ...targets, started_on: todayIn(timezone) })
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
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .lt('log_date', today),
    'load open days',
  );

  if (!openLogs.length) return [];

  const dates = openLogs.map((log) => log.log_date);
  const assignments = unwrap(
    await db
      .from('daily_assignments')
      .select('problem_id, assigned_on, problem:problems(kind)')
      .eq('user_id', userId)
      .eq('round', 1)
      .in('assigned_on', dates),
    'load assignments for open days',
  );

  const [solvedIds, priorGreenDays, account] = await Promise.all([
    getSolvedProblemIds(userId),
    countGreenDays(userId),
    unwrap(
      await db
        .from('users')
        .select('freezes_used, email, name, timezone, current_streak')
        .eq('id', userId)
        .single(),
      'load freeze balance',
    ),
  ]);

  const closed = [];
  let greenDays = priorGreenDays;
  let freezesUsed = account.freezes_used;
  let latestMissed = null;

  for (const log of [...openLogs].sort((a, b) => (a.log_date < b.log_date ? -1 : 1))) {
    const counts = { DSA: 0, LLD: 0, HLD: 0 };
    for (const assignment of assignments) {
      if (assignment.assigned_on === log.log_date && solvedIds.has(assignment.problem_id)) {
        counts[assignment.problem?.kind ?? 'DSA'] += 1;
      }
    }
    const solved = counts.DSA + counts.LLD + counts.HLD;
    const measured = { ...log, dsa_solved: counts.DSA, lld_solved: counts.LLD, hld_solved: counts.HLD };

    let status;
    if (quotaComplete(measured)) {
      status = 'complete';
      greenDays += 1;
    } else if (freezeBalance({ greenDays, freezesUsed }).available > 0) {
      status = 'frozen';
      freezesUsed += 1;
    } else {
      status = 'missed';
    }

    unwrap(
      await db
        .from('daily_logs')
        .update({
          solved_count: solved,
          dsa_solved: counts.DSA,
          lld_solved: counts.LLD,
          hld_solved: counts.HLD,
          status,
          closed_at: new Date().toISOString(),
        })
        .eq('id', log.id),
      'close day',
    );

    closed.push({ date: log.log_date, status, solved, required: log.required_count });
    if (status === 'missed') {
      latestMissed = { id: log.id, date: log.log_date, status, solved, required: log.required_count };
    }
  }
  if (latestMissed) await sendRedDayNotification(account, latestMissed);

  if (freezesUsed !== account.freezes_used) {
    unwrap(await db.from('users').update({ freezes_used: freezesUsed }).eq('id', userId), 'record freeze use');
  }

  return closed;
}

async function countGreenDays(userId) {
  const { count, error } = await db
    .from('daily_logs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'complete');

  if (error) throw Object.assign(new Error(`count green days: ${error.message}`), { status: 500 });
  return count ?? 0;
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
async function pickDailyProblems(userId, today, targets) {
  const [problems, assignments, solvedIds] = await Promise.all([
    unwrap(await db.from('problems').select(PROBLEM_FIELDS).order('order_index'), 'load problems'),
    unwrap(
      await db
        .from('daily_assignments')
        .select('problem_id, assigned_on, round')
        .eq('user_id', userId)
        .eq('round', 1),
      'load past target assignments',
    ),
    getSolvedProblemIds(userId),
  ]);
  const assignedEver = new Set(assignments.map((assignment) => assignment.problem_id));

  const byId = new Map(problems.map((problem) => [problem.id, problem]));
  const firstAssigned = new Map();
  for (const assignment of assignments) {
    const previous = firstAssigned.get(assignment.problem_id);
    if (!previous || assignment.assigned_on < previous) firstAssigned.set(assignment.problem_id, assignment.assigned_on);
  }

  const solvedPerTopic = new Map();
  for (const problem of problems) {
    if (solvedIds.has(problem.id)) {
      const key = `${problem.kind}:${problem.topic}`;
      solvedPerTopic.set(key, (solvedPerTopic.get(key) ?? 0) + 1);
    }
  }

  const allPicks = [];
  for (const kind of KINDS) {
    const target = normalizeDailyTarget(targets[kind], kind);
    if (!target) continue;

    const backlog = [...firstAssigned.entries()]
      .filter(([problemId, date]) => {
        const problem = byId.get(problemId);
        return date < today && !solvedIds.has(problemId) && problem?.kind === kind;
      })
      .sort((a, b) => (a[1] < b[1] ? -1 : 1))
      .map(([problemId]) => ({ problem: byId.get(problemId), carriedOver: true }));

    const fresh = shuffle(
      problems
        .filter((problem) => problem.kind === kind && !solvedIds.has(problem.id) && !assignedEver.has(problem.id))
        .map((problem) => ({ problem, carriedOver: false })),
    );
    fresh.sort((a, b) =>
      (solvedPerTopic.get(`${kind}:${a.problem.topic}`) ?? 0) -
      (solvedPerTopic.get(`${kind}:${b.problem.topic}`) ?? 0));

    const backlogQuota = Math.min(backlog.length, Math.ceil(target * BACKLOG_SHARE));
    const ordered = [...backlog.slice(0, backlogQuota), ...fresh, ...backlog.slice(backlogQuota)];
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
    allPicks.push(...shuffle(picked));
  }

  return allPicks;
}

/** Recomputes solved/bonus counts for a day and flips it green once the target is hit. */
export async function refreshDayCounters(userId, date) {
  const log = unwrap(
    await db.from('daily_logs').select('*').eq('user_id', userId).eq('log_date', date).maybeSingle(),
    'load day log',
  );
  if (!log) return null;

  const [assignments, solvedToday] = await Promise.all([
    unwrap(
      await db
        .from('daily_assignments')
        .select('problem_id, round, problem:problems(kind)')
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

  const assignmentById = new Map(assignments.map((assignment) => [assignment.problem_id, assignment]));
  const counts = { DSA: 0, LLD: 0, HLD: 0 };
  let bonusCount = 0;
  for (const solved of solvedToday) {
    const assignment = assignmentById.get(solved.problem_id);
    if (!assignment) bonusCount += 1;
    else counts[assignment.problem?.kind ?? 'DSA'] += 1;
  }

  const solvedCount = counts.DSA + counts.LLD + counts.HLD;
  const measured = { ...log, dsa_solved: counts.DSA, lld_solved: counts.LLD, hld_solved: counts.HLD };
  const complete = quotaComplete(measured);
  const status = complete ? 'complete' : log.status === 'active' ? 'active' : log.status;

  return unwrap(
    await db
      .from('daily_logs')
      .update({
        solved_count: solvedCount,
        dsa_solved: counts.DSA,
        lld_solved: counts.LLD,
        hld_solved: counts.HLD,
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

async function resetMalformedToday(userId, date) {
  unwrap(
    await db.from('daily_assignments').delete().eq('user_id', userId).eq('assigned_on', date),
    'remove malformed daily assignments',
  );
  unwrap(
    await db.from('daily_logs').delete().eq('user_id', userId).eq('log_date', date),
    'remove malformed daily log',
  );
}

async function isMalformedToday(userId, date, log) {
  if (!log || log.status !== 'active') return false;
  if (log.required_count !== targetTotal(log)) return true;
  const assignments = unwrap(
    await db
      .from('daily_assignments')
      .select('id')
      .eq('user_id', userId)
      .eq('assigned_on', date)
      .eq('round', 1),
    'check daily assignment count',
  );
  return assignments.length > log.required_count;
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
  if (await isMalformedToday(user.id, today, log)) {
    await resetMalformedToday(user.id, today);
    log = null;
  }

  if (!log) {
    const picks = await pickDailyProblems(user.id, today, enrollmentTargets(enrollment));
    const required = { DSA: 0, LLD: 0, HLD: 0 };
    for (const pick of picks) required[pick.problem.kind] += 1;

    const created = await db
      .from('daily_logs')
      .insert({
        user_id: user.id,
        log_date: today,
        required_count: picks.length,
        dsa_required: required.DSA,
        lld_required: required.LLD,
        hld_required: required.HLD,
      })
      .select('*')
      .single();

    if (created.error && created.error.code !== UNIQUE_VIOLATION) {
      throw Object.assign(new Error(`create today log: ${created.error.message}`), { status: 500 });
    }

    if (created.data) {
      log = created.data;
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
    } else {
      log = await waitForDay(user.id, today);
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
    targets: { DSA: log.dsa_required, LLD: log.lld_required, HLD: log.hld_required },
    solvedCount: log.solved_count,
    progress: { DSA: log.dsa_solved, LLD: log.lld_solved, HLD: log.hld_solved },
    bonusCount: log.bonus_count,
    status: log.status,
    isComplete: log.status === 'complete',
    closedDays,
    problems: assignments.filter((row) => row.round === 1).map(toProblem(solvedMap)),
    extraSets: [...new Set(assignments.filter((row) => row.round > 1).map((row) => row.round))]
      .sort((a, b) => b - a)
      .map((round) => ({ round, problems: assignments.filter((row) => row.round === round).map(toProblem(solvedMap)) })),
    canExtend: log.status === 'complete' && enrollment.dsa_target > 0,
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
  if (!enrollment.dsa_target) throw ApiError.badRequest('Set a DSA goal before requesting an extra set');

  const existing = unwrap(
    await db.from('daily_assignments').select('round').eq('user_id', user.id).eq('assigned_on', today),
    'load today rounds',
  );
  const nextRound = maxRound(existing) + 1;
  const picks = await pickDailyProblems(user.id, today, { DSA: enrollment.dsa_target, LLD: 0, HLD: 0 });
  if (!picks.length) throw ApiError.badRequest('Nothing left unsolved — you have finished the DSA sheet');

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
  if (problem.kind !== 'DSA') {
    throw ApiError.badRequest('System Design completion requires a passed Optimus assessment');
  }

  await closeOpenDays(user.id, today);
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

export async function completeAssessedProblem(user, problemId) {
  await requireEnrollment(user.id);
  const today = todayIn(user.timezone);
  const problem = unwrap(
    await db.from('problems').select(PROBLEM_FIELDS).eq('id', problemId).maybeSingle(),
    'load assessed problem',
  );
  if (!problem) throw ApiError.notFound('Problem not found');
  if (problem.kind === 'DSA') throw ApiError.badRequest('DSA problems do not use Optimus assessments');

  const inTargetSet = unwrap(
    await db
      .from('daily_assignments')
      .select('id')
      .eq('user_id', user.id)
      .eq('assigned_on', today)
      .eq('round', 1)
      .eq('problem_id', problemId)
      .maybeSingle(),
    'check assessed assignment',
  );
  unwrap(
    await db.from('user_problems').upsert(
      {
        user_id: user.id,
        problem_id: problemId,
        status: 'solved',
        solved_on: today,
        is_bonus: !inTargetSet,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,problem_id' },
    ),
    'complete assessed problem',
  );
  await refreshDayCounters(user.id, today);
  return problem;
}

export async function unmarkSolved(user, problemId) {
  const today = todayIn(user.timezone);
  const problem = unwrap(
    await db.from('problems').select('kind').eq('id', problemId).maybeSingle(),
    'load problem kind',
  );
  if (!problem) throw ApiError.notFound('Problem not found');
  if (problem.kind !== 'DSA') throw ApiError.badRequest('System Design assessment results cannot be unchecked');

  unwrap(
    await db.from('user_problems').delete().eq('user_id', user.id).eq('problem_id', problemId),
    'unmark problem',
  );
  const log = await refreshDayCounters(user.id, today);
  return { problemId, day: log, streak: await getStreak(user) };
}

/** A frozen day holds the streak; only green days count toward its length. */
const HOLDS_STREAK = new Set(['complete', 'frozen']);

/**
 * Current and longest run, plus the freeze balance. Today still being open
 * never breaks the streak. Also writes the standings the leaderboard reads.
 */
export async function getStreak(user) {
  const today = todayIn(user.timezone);

  const [logs, account, solvedCount] = await Promise.all([
    unwrap(
      await db
        .from('daily_logs')
        .select('log_date, status')
        .eq('user_id', user.id)
        .order('log_date', { ascending: false }),
      'load logs for streak',
    ),
    unwrap(await db.from('users').select('freezes_used').eq('id', user.id).single(), 'load freeze balance'),
    countSolved(user.id),
  ]);

  const statusByDate = new Map(logs.map((log) => [log.log_date, log.status]));

  let current = 0;
  let cursor = statusByDate.get(today) === 'complete' ? today : addDays(today, -1);
  while (HOLDS_STREAK.has(statusByDate.get(cursor))) {
    if (statusByDate.get(cursor) === 'complete') current += 1;
    cursor = addDays(cursor, -1);
  }

  let longest = 0;
  let run = 0;
  let previous = null;
  for (const log of [...logs].reverse()) {
    if (!HOLDS_STREAK.has(log.status)) {
      run = 0;
      previous = log.log_date;
      continue;
    }
    const contiguous = previous && daysBetween(previous, log.log_date) === 1;
    run = contiguous ? run + (log.status === 'complete' ? 1 : 0) : log.status === 'complete' ? 1 : 0;
    longest = Math.max(longest, run);
    previous = log.log_date;
  }

  const greenDays = logs.filter((log) => log.status === 'complete').length;
  const lastCompleteOn = logs.find((log) => log.status === 'complete')?.log_date ?? null;
  // A frozen day holds the streak too, so liveness is judged on this.
  const lastStreakDay = logs.find((log) => HOLDS_STREAK.has(log.status))?.log_date ?? null;

  const streak = {
    current,
    longest,
    greenDays,
    redDays: logs.filter((log) => log.status === 'missed').length,
    frozenDays: logs.filter((log) => log.status === 'frozen').length,
    freezes: freezeBalance({ greenDays, freezesUsed: account.freezes_used }),
  };

  unwrap(
    await db
      .from('users')
      .update({
        current_streak: current,
        longest_streak: Math.max(longest, current),
        green_days: greenDays,
        total_solved: solvedCount,
        last_complete_on: lastCompleteOn,
        last_streak_day: lastStreakDay,
      })
      .eq('id', user.id),
    'update standings',
  );

  return streak;
}

async function countSolved(userId) {
  const { count, error } = await db
    .from('user_problems')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'solved');

  if (error) throw Object.assign(new Error(`count solved: ${error.message}`), { status: 500 });
  return count ?? 0;
}
