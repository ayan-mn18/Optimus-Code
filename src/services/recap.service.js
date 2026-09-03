import { db, unwrap } from '../lib/supabase.js';
import { todayIn, addDays, daysBetween } from '../lib/dates.js';
import { getStreak } from './challenge.service.js';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Monday of the ISO week containing `date`. */
function weekStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

async function weekSlice(userId, start) {
  const end = addDays(start, 6);

  const [solves, logs] = await Promise.all([
    unwrap(
      await db
        .from('user_problems')
        .select(`solved_on, is_bonus, problem:problems(kind, topic, difficulty)`)
        .eq('user_id', userId)
        .eq('status', 'solved')
        .gte('solved_on', start)
        .lte('solved_on', end),
      'load week solves',
    ),
    unwrap(
      await db
        .from('daily_logs')
        .select('log_date, status, solved_count, required_count')
        .eq('user_id', userId)
        .gte('log_date', start)
        .lte('log_date', end),
      'load week logs',
    ),
  ]);

  return { start, end, solves, logs };
}

/**
 * A week's worth of activity, shaped for the shareable card: totals, the daily
 * bars, the topics touched, and the change against the week before.
 */
export async function getWeeklyRecap(user, { weeksAgo = 0 } = {}) {
  const today = todayIn(user.timezone);
  const start = addDays(weekStart(today), -7 * weeksAgo);

  const [week, previous, streak] = await Promise.all([
    weekSlice(user.id, start),
    weekSlice(user.id, addDays(start, -7)),
    getStreak(user),
  ]);

  const logByDate = new Map(week.logs.map((log) => [log.log_date, log]));
  const solvesByDate = week.solves.reduce(
    (acc, row) => acc.set(row.solved_on, (acc.get(row.solved_on) ?? 0) + 1),
    new Map(),
  );

  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    const log = logByDate.get(date);
    return {
      date,
      label: DAY_NAMES[index],
      solved: solvesByDate.get(date) ?? 0,
      target: log?.required_count ?? null,
      status: log?.status ?? (date > today ? 'upcoming' : 'none'),
      isToday: date === today,
    };
  });

  const byTopic = new Map();
  const byDifficulty = { Easy: 0, Medium: 0, Hard: 0 };
  for (const row of week.solves) {
    if (!row.problem) continue;
    byTopic.set(row.problem.topic, (byTopic.get(row.problem.topic) ?? 0) + 1);
    byDifficulty[row.problem.difficulty] = (byDifficulty[row.problem.difficulty] ?? 0) + 1;
  }

  const tracks = ['DSA', 'LLD', 'HLD'].map((kind) => ({
    kind,
    solved: week.solves.filter((row) => row.problem?.kind === kind).length,
  }));

  const solved = week.solves.length;
  const previousSolved = previous.solves.length;
  const greenDays = week.logs.filter((log) => log.status === 'complete').length;
  const bestDay = days.reduce((best, day) => (day.solved > (best?.solved ?? -1) ? day : best), null);

  return {
    weekStart: start,
    weekEnd: addDays(start, 6),
    weeksAgo,
    isCurrentWeek: weeksAgo === 0,
    daysElapsed: Math.min(daysBetween(start, today) + 1, 7),
    user: { name: user.name, avatarSeed: user.avatar_seed },
    totals: {
      solved,
      bonus: week.solves.filter((row) => row.is_bonus).length,
      greenDays,
      redDays: week.logs.filter((log) => log.status === 'missed').length,
      frozenDays: week.logs.filter((log) => log.status === 'frozen').length,
      topicsTouched: byTopic.size,
    },
    change: {
      solved: solved - previousSolved,
      previousSolved,
      percent: previousSolved ? Math.round(((solved - previousSolved) / previousSolved) * 100) : null,
    },
    days,
    bestDay: bestDay && bestDay.solved > 0 ? bestDay : null,
    topics: [...byTopic.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count),
    difficulty: byDifficulty,
    tracks,
    streak,
    headline: headlineFor({ solved, greenDays, change: solved - previousSolved, streak }),
  };
}

/** One line of plain praise or nudge — no fake enthusiasm when the week was thin. */
function headlineFor({ solved, greenDays, change, streak }) {
  if (greenDays === 7) return 'Seven for seven. A perfect week.';
  if (solved === 0) return 'A quiet week. The queue is still there when you are.';
  if (streak.current >= 30) return `${streak.current} days deep and still going.`;
  if (greenDays >= 5) return `${greenDays} green days. That is a real habit now.`;
  if (change > 0) return `Up ${change} on last week. The line is going the right way.`;
  if (greenDays >= 3) return `${greenDays} green days in the book.`;
  return `${solved} solved. Every one counts.`;
}
