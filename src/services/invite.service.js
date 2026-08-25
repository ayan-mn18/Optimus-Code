import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { email, emailConfigured } from './email.service.js';
import { accountReadyEmail, inviteEmail } from '../emails/templates.js';

export const hashInviteToken = (token) => createHash('sha256').update(token).digest('hex');

const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  timezone: user.timezone,
  avatarSeed: user.avatar_seed,
  showOnLeaderboard: user.show_on_leaderboard ?? true,
  createdAt: user.created_at,
});

function inviteLink(token) {
  const url = new URL('/invite', env.email.appUrl);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

export async function issueWaitlistInvite(
  waitlistEntry,
  { sender = email, enabled = emailConfigured() } = {},
) {
  if (!enabled) return { sent: false, reason: 'not_configured' };

  const account = unwrap(
    await db.from('users').select('id').eq('email', waitlistEntry.email).maybeSingle(),
    'check invited account',
  );
  if (account) return { sent: false, reason: 'account_exists' };

  const active = unwrap(
    await db
      .from('account_invites')
      .select('id')
      .eq('waitlist_id', waitlistEntry.id)
      .is('used_at', null)
      .is('revoked_at', null)
      .not('sent_at', 'is', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    'check active invite',
  );
  if (active) return { sent: true, alreadySent: true };

  unwrap(
    await db
      .from('account_invites')
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('waitlist_id', waitlistEntry.id)
      .is('used_at', null)
      .is('revoked_at', null),
    'revoke old invites',
  );

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.email.inviteTtlHours * 60 * 60 * 1000).toISOString();
  const invite = unwrap(
    await db
      .from('account_invites')
      .insert({
        waitlist_id: waitlistEntry.id,
        email: waitlistEntry.email,
        token_hash: hashInviteToken(token),
        expires_at: expiresAt,
      })
      .select('id')
      .single(),
    'create account invite',
  );

  try {
    const result = await sender.send({
      to: waitlistEntry.email,
      message: inviteEmail({
        name: waitlistEntry.name,
        inviteUrl: inviteLink(token),
        expiresHours: env.email.inviteTtlHours,
      }),
      idempotencyKey: `waitlist-invite/${invite.id}`,
    });

    if (!result.sent) return result;
    unwrap(
      await db
        .from('account_invites')
        .update({
          sent_at: new Date().toISOString(),
          provider_message_id: result.messageId,
          send_attempts: 1,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', invite.id),
      'record sent invite',
    );
    return { sent: true };
  } catch (error) {
    unwrap(
      await db
        .from('account_invites')
        .update({
          revoked_at: new Date().toISOString(),
          send_attempts: 1,
          last_error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown email error',
          updated_at: new Date().toISOString(),
        })
        .eq('id', invite.id),
      'record failed invite',
    );
    return { sent: false, reason: 'send_failed' };
  }
}

export async function sendPendingWaitlistInvites(
  { sender = email, enabled = emailConfigured() } = {},
) {
  if (!enabled) return { checked: 0, sent: 0 };

  const entries = unwrap(
    await db.from('waitlist').select('*').order('created_at', { ascending: true }),
    'load pending waitlist invites',
  );
  let sent = 0;
  for (const entry of entries) {
    const result = await issueWaitlistInvite(entry, { sender, enabled });
    if (result.sent && !result.alreadySent) sent += 1;
  }
  return { checked: entries.length, sent };
}

async function validInvite(token) {
  const invite = unwrap(
    await db
      .from('account_invites')
      .select('id, email, expires_at, used_at, revoked_at')
      .eq('token_hash', hashInviteToken(token))
      .maybeSingle(),
    'load account invite',
  );

  if (!invite || invite.used_at || invite.revoked_at || Date.parse(invite.expires_at) <= Date.now()) {
    throw ApiError.notFound('Invite is invalid or expired');
  }
  return invite;
}

export async function inspectInvite(token) {
  const invite = await validInvite(token);
  const account = unwrap(
    await db.from('users').select('id').eq('email', invite.email).maybeSingle(),
    'check invite account',
  );
  if (account) throw ApiError.conflict('An account already exists for this email');
  return { email: invite.email, expiresAt: invite.expires_at };
}

export async function acceptInvite(
  token,
  { name, password, timezone },
  { sender = email, enabled = emailConfigured() } = {},
) {
  const invite = await validInvite(token);
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await db.rpc('accept_waitlist_invite', {
    p_token_hash: hashInviteToken(token),
    p_name: name,
    p_password_hash: passwordHash,
    p_timezone: timezone,
    p_avatar_seed: invite.email.split('@')[0],
  });

  if (result.error) {
    if (result.error.code === '23505') throw ApiError.conflict('An account already exists for this email');
    if (result.error.code === 'P0001') throw ApiError.badRequest('Invite is invalid or expired');
    throw Object.assign(new Error(`accept account invite: ${result.error.message}`), { status: 500 });
  }

  const user = result.data?.[0];
  if (!user) throw Object.assign(new Error('accept account invite: user was not returned'), { status: 500 });

  if (enabled) {
    try {
      const loginUrl = `${env.email.appUrl}/login?email=${encodeURIComponent(user.email)}`;
      const sent = await sender.send({
        to: user.email,
        message: accountReadyEmail({ name: user.name, loginUrl }),
        idempotencyKey: `account-ready/${invite.id}`,
      });
      if (sent.sent) {
        unwrap(
          await db.from('account_invites').update({ welcome_sent_at: new Date().toISOString() }).eq('id', invite.id),
          'record welcome email',
        );
      }
    } catch {
      // Account creation is complete. A welcome-email outage must never roll it back.
    }
  }

  return publicUser(user);
}
