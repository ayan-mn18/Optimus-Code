-- Paid System Design access with permanent exceptions for existing accounts.
-- New users default to paid access; this backfill intentionally runs once at
-- rollout so all accounts that already existed retain complimentary Pro.

alter table public.users
  add column if not exists billing_exempt boolean not null default false;

alter table public.subscriptions
  add column if not exists renewal_reminder_sent_at timestamptz;

update public.users
set billing_exempt = true
where billing_exempt = false;
