import { db, unwrap } from '../lib/supabase.js';
import { todayIn, addDays } from '../lib/dates.js';
import { getStreak } from './challenge.service.js';

const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

/** Everything the dashboard needs: topic mastery, difficulty split, heatmap, streak. */
export async function getOverview(user, { heatmapDays = 182 } = {}) {
  const today = todayIn(user.timezone);
  const since = addDays(today, -(heatmapDays - 1));

  const [problems, solved, logs, streak, assignments] = await Promise.all([
    unwrap(await db.from('problems').select('id, topic, difficulty'), 'load problems'),
    unwrap(
      await db
        .from('user_problems')
        .select('problem_id, solved_on, is_bonus')
        .eq('user_id', user.id)
        .eq('status', 'solved'),
      'load solves',
    ),
    unwrap(
      await db
        .from('daily_logs')
        .select('log_date, status, solved_count, bonus_count, required_count')
        .eq('user_id', user.id)
        .gte('log_date', since)
        .order('log_date'),
      'load logs',
    ),
    getStreak(user),
    unwrap(
      await db
        .from('daily_assignments')
        .select('problem_id, assigned_on')
        .eq('user_id', user.id)
        .eq('round', 1),
      'load target assignments',
    ),
  ]);

  const problemById = new Map(problems.map((p) => [p.id, p]));
  const solvedIds = new Set(solved.map((row) => row.problem_id));

  // ---- topic mastery -------------------------------------------------------
  const topics = new Map();
  for (const problem of problems) {
    if (!topics.has(problem.topic)) {
      topics.set(problem.topic, { topic: problem.topic, total: 0, solved: 0, easy: 0, medium: 0, hard: 0 });
    }
    const bucket = topics.get(problem.topic);
    bucket.total += 1;
    if (solvedIds.has(problem.id)) {
      bucket.solved += 1;
      bucket[problem.difficulty.toLowerCase()] += 1;
    }
  }

  // ---- difficulty split ----------------------------------------------------
  const difficulty = DIFFICULTIES.map((level) => {
    const total = problems.filter((p) => p.difficulty === level).length;
    const done = problems.filter((p) => p.difficulty === level && solvedIds.has(p.id)).length;
    return { difficulty: level, total, solved: done, percent: total ? Math.round((done / total) * 100) : 0 };
  });

  // ---- heatmap -------------------------------------------------------------
  const logByDate = new Map(logs.map((log) => [log.log_date, log]));
  const solvesByDate = solved.reduce((acc, row) => acc.set(row.solved_on, (acc.get(row.solved_on) ?? 0) + 1), new Map());

  const heatmap = [];
  for (let i = heatmapDays - 1; i >= 0; i -= 1) {
    const date = addDays(today, -i);
    const log = logByDate.get(date);
    heatmap.push({
      date,
      count: solvesByDate.get(date) ?? 0,
      status: log?.status ?? (date === today ? 'idle' : 'none'),
      target: log?.required_count ?? null,
    });
  }

  // ---- backlog (unsolved problems that already came around once) -----------
  const firstAssigned = new Map();
  for (const a of assignments) {
    const prev = firstAssigned.get(a.problem_id);
    if (!prev || a.assigned_on < prev) firstAssigned.set(a.problem_id, a.assigned_on);
  }
  const backlog = [...firstAssigned.entries()]
    .filter(([id, date]) => date < today && !solvedIds.has(id) && problemById.has(id))
    .map(([id, date]) => ({ problemId: id, firstAssignedOn: date }));

  return {
    totals: {
      totalProblems: problems.length,
      solved: solvedIds.size,
      percent: problems.length ? Math.round((solvedIds.size / problems.length) * 100) : 0,
      bonusSolved: solved.filter((row) => row.is_bonus).length,
      backlog: backlog.length,
    },
    streak,
    topics: [...topics.values()].sort((a, b) => b.solved / b.total - a.solved / a.total || a.topic.localeCompare(b.topic)),
    difficulty,
    heatmap,
    recentDays: logs.slice(-14).reverse(),
  };
}

/** Complete problem explorer payload; filtering and pagination stay client-side. */
export async function listProblems(user) {
  const [problems, solved] = await Promise.all([
    unwrap(await db.from('problems').select('*').order('order_index'), 'load problems'),
    unwrap(
      await db
        .from('user_problems')
        .select('problem_id, solved_on')
        .eq('user_id', user.id)
        .eq('status', 'solved'),
      'load solve state',
    ),
  ]);
  const solvedMap = new Map(solved.map((row) => [row.problem_id, row.solved_on]));
  const items = problems.map((problem) => ({
    ...problem,
    solved: solvedMap.has(problem.id),
    solvedOn: solvedMap.get(problem.id) ?? null,
  }));

  return { items, total: items.length };
}
