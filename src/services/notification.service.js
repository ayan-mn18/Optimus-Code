import { db, unwrap } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { todayIn } from '../lib/dates.js';
import { email, emailConfigured } from './email.service.js';
import { sendPendingWaitlistInvites } from './invite.service.js';
import {
  billingEmail,
  greenStreakEmail,
  inactiveWeeklyEmail,
  milestoneEmail,
  redDayEmail,
  streakRiskEmail,
} from '../emails/templates.js';

const dashboardUrl = `${env.email.appUrl}/dashboard`;
export const GREEN_STREAK_STEP = 7;
export const INACTIVE_DAYS_THRESHOLD = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const UNIQUE_VIOLATION = '23505';

function localHour(date, timezone) {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).find(({ type }) => type === 'hour');
  return Number(part?.value ?? 0);
}

export function inactivityState(user, now = new Date()) {
  const anchor = new Date(user.last_activity_at ?? user.last_login_at ?? user.created_at ?? now.toISOString());
  const inactiveDays = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / DAY_MS));
  return {
    inactiveDays,
    inactive: inactiveDays >= INACTIVE_DAYS_THRESHOLD,
    inactiveWeek: Math.floor(inactiveDays / INACTIVE_DAYS_THRESHOLD),
  };
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

export async function sendInactiveWeeklyReminder(
  user,
  { now = new Date(), sender = email, enabled = emailConfigured() } = {},
) {
  const state = inactivityState(user, now);
  if (!enabled || !user.email || !state.inactive) return false;

  let event = unwrap(
    await db
      .from('inactive_reminder_events')
      .select('id, emailed_at')
      .eq('user_id', user.id)
      .eq('inactive_week', state.inactiveWeek)
      .maybeSingle(),
    'load inactive reminder state',
  );
  if (!event) {
    const created = await db
      .from('inactive_reminder_events')
      .insert({ user_id: user.id, inactive_week: state.inactiveWeek })
      .select('id, emailed_at')
      .maybeSingle();
    if (created.error && created.error.code !== UNIQUE_VIOLATION) {
      throw Object.assign(new Error(`create inactive reminder state: ${created.error.message}`), { status: 500 });
    }
    event = created.data;
    if (!event) {
      event = unwrap(
        await db
          .from('inactive_reminder_events')
          .select('id, emailed_at')
          .eq('user_id', user.id)
          .eq('inactive_week', state.inactiveWeek)
          .single(),
        'load concurrent inactive reminder state',
      );
    }
  }
  if (event.emailed_at) return false;

  const result = await sender.send({
    to: user.email,
    message: inactiveWeeklyEmail({
      name: user.name,
      inactiveDays: state.inactiveDays,
      loginUrl: dashboardUrl,
    }),
    idempotencyKey: `inactive-weekly/${user.id}/${state.inactiveWeek}`,
  });
  if (!result.sent) return false;

  unwrap(
    await db.from('inactive_reminder_events').update({ emailed_at: now.toISOString() }).eq('id', event.id),
    'record inactive reminder email',
  );
  // A weekly re-engagement replaces the backlog of daily red-day messages.
  unwrap(
    await db
      .from('daily_logs')
      .update({ red_alerted_at: now.toISOString() })
      .eq('user_id', user.id)
      .eq('status', 'missed')
      .is('red_alerted_at', null),
    'suppress inactive red-day emails',
  );
  return true;
}

export async function sendPendingInactiveWeeklyReminders(now = new Date()) {
  if (!emailConfigured()) return { checked: 0, sent: 0 };

  const enrollments = unwrap(
    await db.from('enrollments').select('user_id').eq('status', 'active').limit(5000),
    'load enrolled users for inactive reminders',
  );
  const userIds = [...new Set(enrollments.map((enrollment) => enrollment.user_id))];
  if (!userIds.length) return { checked: 0, sent: 0 };

  const users = unwrap(
    await db.from('users').select('id, email, name, last_activity_at, last_login_at, created_at').in('id', userIds),
    'load inactive reminder users',
  );
  let sent = 0;
  for (const user of users) {
    try {
      if (await sendInactiveWeeklyReminder(user, { now })) sent += 1;
    } catch (error) {
      console.error('[email] inactive reminder failed:', error instanceof Error ? error.message : error);
    }
  }
  return { checked: users.length, sent };
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
    await db.from('users').select('id, email, name, timezone, current_streak, last_activity_at, last_login_at, created_at').in('id', userIds),
    'load streak-risk users',
  );
  const userById = new Map(users.map((user) => [user.id, user]));
  let sent = 0;

  for (const log of logs) {
    const user = userById.get(log.user_id);
    if (!user || inactivityState(user, now).inactive || todayIn(user.timezone) !== log.log_date) continue;

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

/**
 * Closes open days for users who are not actively using the app. The API also
 * settles days on request, but email delivery must not depend on a login.
 */
export async function runHeadlessDayClosures() {
  if (!emailConfigured()) return { checked: 0, closed: 0 };

  const activeLogs = unwrap(
    await db.from('daily_logs').select('user_id').eq('status', 'active').limit(5000),
    'load users with open days',
  );
  const userIds = [...new Set(activeLogs.map((log) => log.user_id))];
  if (!userIds.length) return { checked: 0, closed: 0 };

  const users = unwrap(
    await db.from('users').select('id, timezone').in('id', userIds),
    'load users for day closure',
  );
  const { closeOpenDays } = await import('./challenge.service.js');
  let closed = 0;
  for (const user of users) {
    const days = await closeOpenDays(user.id, todayIn(user.timezone));
    closed += days.length;
  }
  return { checked: users.length, closed };
}

/** Delivers red-day messages queued by a headless closure or a later login. */
export async function sendPendingRedDayEmails() {
  if (!emailConfigured()) return { checked: 0, sent: 0 };

  const logs = unwrap(
    await db
      .from('daily_logs')
      .select('id, user_id, log_date, solved_count, required_count')
      .eq('status', 'missed')
      .is('red_alerted_at', null)
      .order('closed_at', { ascending: true })
      .limit(100),
    'load pending red-day emails',
  );
  if (!logs.length) return { checked: 0, sent: 0 };

  const users = unwrap(
    await db.from('users').select('id, email, name, last_activity_at, last_login_at, created_at').in('id', [...new Set(logs.map((log) => log.user_id))]),
    'load red-day email users',
  );
  const userById = new Map(users.map((user) => [user.id, user]));
  let sent = 0;
  for (const log of logs) {
    const user = userById.get(log.user_id);
    if (!user || inactivityState(user).inactive) continue;
    const delivered = await sendRedDayNotification(user, {
      id: log.id,
      status: 'missed',
      date: log.log_date,
      solved: log.solved_count,
      required: log.required_count,
    });
    if (delivered) sent += 1;
  }
  return { checked: logs.length, sent };
}

/** Sends one reminder roughly three days before an automatic renewal. */
export async function runSubscriptionRenewalReminders(
  now = new Date(),
  { sender = email, enabled = emailConfigured() } = {},
) {
  if (!enabled) return { checked: 0, sent: 0 };

  const start = now.toISOString();
  const end = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const subscriptions = unwrap(
    await db
      .from('subscriptions')
      .select('id, user_id, plan, current_period_end, renewal_reminder_sent_at')
      .eq('status', 'active')
      .eq('cancel_at_period_end', false)
      .is('renewal_reminder_sent_at', null)
      .gte('current_period_end', start)
      .lte('current_period_end', end)
      .limit(100),
    'load subscription renewal reminders',
  );
  if (!subscriptions.length) return { checked: 0, sent: 0 };

  const users = unwrap(
    await db.from('users').select('id, email, name').in('id', [...new Set(subscriptions.map(({ user_id: userId }) => userId))]),
    'load subscription reminder users',
  );
  const userById = new Map(users.map((user) => [user.id, user]));
  let sent = 0;
  for (const subscription of subscriptions) {
    const user = userById.get(subscription.user_id);
    if (!user?.email) continue;
    try {
      const result = await sender.send({
        to: user.email,
        message: billingEmail({
          kind: 'reminder',
          name: user.name,
          plan: subscription.plan,
          nextBillingDate: subscription.current_period_end,
          loginUrl: `${env.email.appUrl}/settings`,
        }),
        idempotencyKey: `billing-renewal/${subscription.id}/${subscription.current_period_end}`,
      });
      if (!result.sent) continue;

      unwrap(
        await db.from('subscriptions').update({ renewal_reminder_sent_at: new Date().toISOString() }).eq('id', subscription.id).is('renewal_reminder_sent_at', null),
        'record subscription renewal reminder',
      );
      sent += 1;
    } catch (error) {
      console.error('[email] subscription renewal reminder failed:', error instanceof Error ? error.message : error);
    }
  }
  return { checked: subscriptions.length, sent };
}

export function startEmailNotificationWorker() {
  if (!emailConfigured()) return () => {};

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runHeadlessDayClosures();
      await sendPendingInactiveWeeklyReminders();
      await sendPendingRedDayEmails();
      await Promise.all([
        runStreakRiskNotifications(),
        runSubscriptionRenewalReminders(),
        sendPendingGreenStreakEmails(),
        sendPendingWaitlistInvites(),
        sendPendingMilestoneEmails(),
      ]);
    } catch (error) {
      console.error('[email] notification worker failed:', error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
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
