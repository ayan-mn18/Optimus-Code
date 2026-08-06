import { db, unwrap } from '../lib/supabase.js';
import { todayIn, addDays } from '../lib/dates.js';

/** How many rows the board shows before the viewer's own row is appended. */
const BOARD_SIZE = 50;

/**
 * A stored streak only counts while it is still alive. Standings are written
 * whenever a user's streak is recomputed, so someone who stopped showing up
 * still carries their last number until they next open the app — this drops it
 * to zero as soon as the run has actually lapsed.
 */
function liveStreak(row, today) {
  // A frozen day holds the streak, so the check uses the last streak-holding
  // day rather than the last green one.
  const lastHeld = row.last_streak_day ?? row.last_complete_on;
  if (!lastHeld) return 0;
  return lastHeld >= addDays(today, -1) ? row.current_streak : 0;
}

const rank = (rows) =>
  rows.map((row, index) => ({
    rank: index + 1,
    userId: row.id,
    name: row.name,
    avatarSeed: row.avatar_seed,
    streak: row.liveStreak,
    longestStreak: row.longest_streak,
    greenDays: row.green_days,
    solved: row.total_solved,
    joinedOn: row.created_at,
  }));

/**
 * Ranked by live streak, then problems solved, then who started earlier.
 * Users who opted out are excluded from the board but still get their own
 * standing back so the page is not a dead end for them.
 */
export async function getLeaderboard(viewer, { metric = 'streak' } = {}) {
  const today = todayIn(viewer.timezone);

  const rows = unwrap(
    await db
      .from('users')
      .select('id, name, avatar_seed, current_streak, longest_streak, green_days, total_solved, last_complete_on, last_streak_day, created_at, show_on_leaderboard')
      .eq('show_on_leaderboard', true),
    'load leaderboard',
  ).map((row) => ({ ...row, liveStreak: liveStreak(row, today) }));

  const comparators = {
    streak: (a, b) => b.liveStreak - a.liveStreak || b.total_solved - a.total_solved,
    solved: (a, b) => b.total_solved - a.total_solved || b.liveStreak - a.liveStreak,
    consistency: (a, b) => b.green_days - a.green_days || b.total_solved - a.total_solved,
  };

  const sorted = rows.sort(
    (a, b) => (comparators[metric] ?? comparators.streak)(a, b) || (a.created_at < b.created_at ? -1 : 1),
  );

  const ranked = rank(sorted);
  const meIndex = ranked.findIndex((entry) => entry.userId === viewer.id);

  const self = unwrap(
    await db
      .from('users')
      .select('id, name, avatar_seed, current_streak, longest_streak, green_days, total_solved, last_complete_on, last_streak_day, created_at')
      .eq('id', viewer.id)
      .single(),
    'load own standing',
  );

  return {
    metric,
    total: ranked.length,
    entries: ranked.slice(0, BOARD_SIZE),
    me: {
      ...rank([{ ...self, liveStreak: liveStreak(self, today) }])[0],
      rank: meIndex >= 0 ? meIndex + 1 : null,
      onBoard: meIndex >= 0,
      inTop: meIndex >= 0 && meIndex < BOARD_SIZE,
    },
  };
}
