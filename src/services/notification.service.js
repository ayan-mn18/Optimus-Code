import { db, unwrap } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { todayIn } from '../lib/dates.js';
import { email, emailConfigured } from './email.service.js';
import { sendPendingWaitlistInvites } from './invite.service.js';
import { greenStreakEmail, milestoneEmail, redDayEmail, streakRiskEmail } from '../emails/templates.js';

const dashboardUrl = `${env.email.appUrl}/dashboard`;
export const GREEN_STREAK_STEP = 7;
const UNIQUE_VIOLATION = '23505';

function localHour(date, timezone) {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).find(({ type }) => type === 'hour');
  return Number(part?.value ?? 0);
}

export async function sendMilestoneNotification(
  user,
  snapshot,
  { sender = email, enabled = emailConfigured() } = {},
) {
  if (!enabled) return false;

  const row = unwrap(
    await db
      .from('milestone_recaps')
      .select('id, emailed_at')
      .eq('user_id', user.id)
      .eq('milestone', snapshot.milestone)
      .single(),
    'load milestone email state',
  );
  if (row.emailed_at) return false;

  try {
    const result = await sender.send({
      to: user.email,
      message: milestoneEmail({
        name: user.name,
        milestone: snapshot.milestone,
        headline: snapshot.headline,
        topTopics: snapshot.topTopics,
        nextMilestone: snapshot.nextMilestone,
        appUrl: env.email.appUrl,
      }),
      idempotencyKey: `milestone/${user.id}/${snapshot.milestone}`,
    });
    if (!result.sent) return false;

    unwrap(
      await db.from('milestone_recaps').update({ emailed_at: new Date().toISOString() }).eq('id', row.id),
      'record milestone email',
    );
    return true;
  } catch (error) {
    console.error('[email] milestone delivery failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

export async function sendPendingMilestoneEmails() {
  if (!emailConfigured()) return { checked: 0, sent: 0 };

  const recaps = unwrap(
    await db
      .from('milestone_recaps')
      .select('user_id, snapshot')
      .is('emailed_at', null)
      .order('created_at', { ascending: true })
      .limit(50),
    'load pending milestone emails',
  );
  if (!recaps.length) return { checked: 0, sent: 0 };

  const users = unwrap(
    await db
      .from('users')
      .select('id, email, name')
      .in('id', [...new Set(recaps.map((recap) => recap.user_id))]),
    'load milestone email users',
  );
  const userById = new Map(users.map((user) => [user.id, user]));
  let sent = 0;
  for (const recap of recaps) {
    const user = userById.get(recap.user_id);
    if (user && await sendMilestoneNotification(user, recap.snapshot)) sent += 1;
  }
  return { checked: recaps.length, sent };
}

export async function sendRedDayNotification(
  user,
  log,
  { sender = email, enabled = emailConfigured() } = {},
) {
  if (!enabled || log.status !== 'missed') return false;

  const state = unwrap(
    await db.from('daily_logs').select('red_alerted_at').eq('id', log.id).single(),
    'load red-day email state',
  );
  if (state.red_alerted_at) return false;

  try {
    const result = await sender.send({
      to: user.email,
      message: redDayEmail({
        name: user.name,
        date: log.date,
        solved: log.solved,
        required: log.required,
        loginUrl: dashboardUrl,
      }),
      idempotencyKey: `red-day/${log.id}`,
    });
    if (!result.sent) return false;

    unwrap(
      await db.from('daily_logs').update({ red_alerted_at: new Date().toISOString() }).eq('id', log.id),
      'record red-day email',
    );
    return true;
  } catch (error) {
    console.error('[email] red-day delivery failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Creates a durable, idempotent event before delivery. A retry can safely send
 * the same milestone after a transient SMTP outage without duplicating it.
 */
export async function sendGreenStreakNotification(
  user,
  streak,
  { sender = email, enabled = emailConfigured(), achievedOn = todayIn(user.timezone), existingState } = {},
) {
  const streakLength = Number(streak?.current ?? 0);
  if (!enabled || streakLength < GREEN_STREAK_STEP || streakLength % GREEN_STREAK_STEP !== 0) return false;

  let state = existingState;
  try {
    if (!state) {
      state = unwrap(
        await db
          .from('streak_milestones')
          .select('id, emailed_at')
          .eq('user_id', user.id)
          .eq('streak_length', streakLength)
          .eq('achieved_on', achievedOn)
          .maybeSingle(),
        'load streak milestone email state',
      );
    }
    if (!state) {
      const created = await db
        .from('streak_milestones')
        .insert({ user_id: user.id, streak_length: streakLength, achieved_on: achievedOn })
        .select('id, emailed_at')
        .maybeSingle();
      if (created.error && created.error.code !== UNIQUE_VIOLATION) {
        throw Object.assign(new Error(`create streak milestone email: ${created.error.message}`), { status: 500 });
      }
      state = created.data;
      if (!state) {
        state = unwrap(
          await db
            .from('streak_milestones')
            .select('id, emailed_at')
            .eq('user_id', user.id)
            .eq('streak_length', streakLength)
            .eq('achieved_on', achievedOn)
            .single(),
          'load concurrent streak milestone email',
        );
      }
    }
  } catch (error) {
    console.error('[email] green-streak state failed:', error instanceof Error ? error.message : error);
    return false;
  }
  if (state.emailed_at) return false;

  try {
    const result = await sender.send({
      to: user.email,
      message: greenStreakEmail({
        name: user.name,
        streakLength,
        longestStreak: Math.max(Number(user.longest_streak ?? 0), streakLength),
        loginUrl: dashboardUrl,
      }),
      idempotencyKey: `green-streak/${user.id}/${streakLength}/${achievedOn}`,
    });
    if (!result.sent) return false;

    unwrap(
      await db.from('streak_milestones').update({ emailed_at: new Date().toISOString() }).eq('id', state.id),
      'record streak milestone email',
    );
    return true;
  } catch (error) {
    console.error('[email] green-streak delivery failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

export async function sendPendingGreenStreakEmails() {
  if (!emailConfigured()) return { checked: 0, sent: 0 };

  const milestones = unwrap(
    await db
      .from('streak_milestones')
      .select('id, user_id, streak_length, achieved_on, emailed_at')
      .is('emailed_at', null)
      .order('created_at', { ascending: true })
      .limit(50),
    'load pending streak milestone emails',
  );
  if (!milestones.length) return { checked: 0, sent: 0 };

  const users = unwrap(
    await db
      .from('users')
      .select('id, email, name, longest_streak')
      .in('id', [...new Set(milestones.map((milestone) => milestone.user_id))]),
    'load streak milestone email users',
  );
  const userById = new Map(users.map((user) => [user.id, user]));
  let sent = 0;
  for (const milestone of milestones) {
    const user = userById.get(milestone.user_id);
    if (!user) continue;
    const delivered = await sendGreenStreakNotification(
      user,
      { current: milestone.streak_length },
      {
        existingState: milestone,
        achievedOn: milestone.achieved_on,
      },
    );
    if (delivered) sent += 1;
  }
  return { checked: milestones.length, sent };
}

export async function runStreakRiskNotifications(
  now = new Date(),
  { sender = email, enabled = emailConfigured(), onlyUserIds } = {},
) {
  if (!enabled) return { checked: 0, sent: 0 };

  let logQuery = db
    .from('daily_logs')
    .select('id, user_id, log_date, required_count, solved_count')
    .eq('status', 'active')
    .is('streak_warned_at', null);
  if (onlyUserIds?.length) logQuery = logQuery.in('user_id', onlyUserIds);
  const logs = unwrap(await logQuery, 'load streak-risk days');
  if (!logs.length) return { checked: 0, sent: 0 };

  const userIds = [...new Set(logs.map((log) => log.user_id))];
  const users = unwrap(
    await db.from('users').select('id, email, name, timezone, current_streak').in('id', userIds),
    'load streak-risk users',
  );
  const userById = new Map(users.map((user) => [user.id, user]));
  let sent = 0;

  for (const log of logs) {
    const user = userById.get(log.user_id);
    if (!user || todayIn(user.timezone) !== log.log_date) continue;

    const hour = localHour(now, user.timezone);
    const remaining = Math.max(log.required_count - log.solved_count, 0);
    if (hour < env.email.warningHour || remaining === 0) continue;

    try {
      const result = await sender.send({
        to: user.email,
        message: streakRiskEmail({
          name: user.name,
          remaining,
          currentStreak: user.current_streak,
          hoursLeft: Math.max(1, 24 - hour),
          loginUrl: dashboardUrl,
        }),
        idempotencyKey: `streak-risk/${log.id}`,
      });
      if (!result.sent) continue;

      unwrap(
        await db.from('daily_logs').update({ streak_warned_at: new Date().toISOString() }).eq('id', log.id),
        'record streak-risk email',
      );
      sent += 1;
    } catch (error) {
      console.error('[email] streak warning failed:', error instanceof Error ? error.message : error);
    }
  }

  return { checked: logs.length, sent };
}

export function startEmailNotificationWorker() {
  if (!emailConfigured()) return () => {};

  const run = () => {
    Promise.all([
      runStreakRiskNotifications(),
      sendPendingGreenStreakEmails(),
      sendPendingWaitlistInvites(),
      sendPendingMilestoneEmails(),
    ]).catch((error) => {
      console.error('[email] notification worker failed:', error instanceof Error ? error.message : error);
    });
  };
  const initial = setTimeout(run, 5_000);
  const interval = setInterval(run, env.email.workerIntervalMs);
  initial.unref();
  interval.unref();

  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
