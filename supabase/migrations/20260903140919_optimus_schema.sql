-- Generated from db/schema.sql by `npm run db:migration`. Do not edit directly.

-- ============================================================================
-- Optimus Code — Supabase / Postgres schema
-- Run this once in the Supabase SQL editor, then `npm run seed`.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text,
  google_sub    text unique,
  auth_provider text not null default 'password'
    check (auth_provider in ('password', 'google')),
  name          text not null,
  timezone      text not null default 'UTC',
  avatar_seed   text not null default 'optimus',
  picture_url   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists users_email_idx on public.users (lower(email));

-- Denormalised standings, refreshed whenever a user's streak is recomputed.
-- The leaderboard reads these instead of replaying every user's daily_logs;
-- last_complete_on lets a reader tell a live streak from a stale one.
alter table public.users add column if not exists current_streak      int  not null default 0;
alter table public.users add column if not exists longest_streak      int  not null default 0;
alter table public.users add column if not exists green_days          int  not null default 0;
alter table public.users add column if not exists total_solved        int  not null default 0;
alter table public.users add column if not exists last_complete_on    date;
-- Most recent day that HELD the streak — complete or covered by a freeze.
-- Liveness is judged on this, not on last_complete_on.
alter table public.users add column if not exists last_streak_day     date;
alter table public.users add column if not exists show_on_leaderboard boolean not null default true;

-- Streak freezes: one earned per 10 green days. `freezes_used` is the only
-- stored half — the balance is derived, so an award can never double-fire.
alter table public.users add column if not exists freezes_used int not null default 0;
alter table public.users alter column password_hash drop not null;
alter table public.users add column if not exists google_sub text;
alter table public.users add column if not exists auth_provider text not null default 'password';
alter table public.users add column if not exists picture_url text;
create unique index if not exists users_google_sub_idx on public.users (google_sub) where google_sub is not null;
alter table public.users drop constraint if exists users_auth_provider_check;
alter table public.users add constraint users_auth_provider_check
  check (auth_provider in ('password', 'google'));

create index if not exists users_leaderboard_idx
  on public.users (show_on_leaderboard, current_streak desc, total_solved desc);

-- ---------------------------------------------------------------------------
-- refresh_tokens (rotating, hashed)
-- ---------------------------------------------------------------------------
create table if not exists public.refresh_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists refresh_tokens_user_idx on public.refresh_tokens (user_id);

-- ---------------------------------------------------------------------------
-- problems (seeded from the Striver SDE Sheet)
-- ---------------------------------------------------------------------------
create table if not exists public.problems (
  id           uuid primary key default gen_random_uuid(),
  slug                text not null,
  title               text not null,
  kind                text not null default 'DSA' check (kind in ('DSA', 'LLD', 'HLD')),
  topic               text not null,
  subtopic            text,
  difficulty          text not null check (difficulty in ('Easy', 'Medium', 'Hard')),
  description         text,
  leetcode_url        text,
  youtube_url         text,
  article_url         text,
  practice_url        text,
  source_url          text,
  resource_metadata   jsonb not null default '{}'::jsonb,
  assessment_enabled  boolean not null default false,
  coding_enabled      boolean not null default false,
  source              text not null default 'Striver SDE Sheet',
  order_index         int  not null default 0,
  created_at          timestamptz not null default now(),
  unique (kind, slug)
);
alter table public.problems add column if not exists kind text not null default 'DSA';
alter table public.problems add column if not exists subtopic text;
alter table public.problems add column if not exists description text;
alter table public.problems add column if not exists practice_url text;
alter table public.problems add column if not exists source_url text;
alter table public.problems add column if not exists resource_metadata jsonb not null default '{}'::jsonb;
alter table public.problems add column if not exists assessment_enabled boolean not null default false;
alter table public.problems add column if not exists coding_enabled boolean not null default false;
alter table public.problems drop constraint if exists problems_slug_key;
create unique index if not exists problems_kind_slug_idx on public.problems (kind, slug);
alter table public.problems drop constraint if exists problems_kind_check;
alter table public.problems add constraint problems_kind_check check (kind in ('DSA', 'LLD', 'HLD'));

create index if not exists problems_topic_idx      on public.problems (topic);
create index if not exists problems_difficulty_idx on public.problems (difficulty);

-- ---------------------------------------------------------------------------
-- enrollments — a user signing up for the daily challenge
-- ---------------------------------------------------------------------------
create table if not exists public.enrollments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  dsa_target   int  not null default 3 check (dsa_target between 0 and 20),
  lld_target   int  not null default 1 check (lld_target between 0 and 10),
  hld_target   int  not null default 1 check (hld_target between 0 and 10),
  status       text not null default 'active' check (status in ('active', 'paused')),
  started_on   date not null,
  created_at   timestamptz not null default now(),
  unique (user_id),
  check (dsa_target + lld_target + hld_target between 1 and 20)
);

alter table public.enrollments add column if not exists dsa_target int not null default 3;
alter table public.enrollments add column if not exists lld_target int not null default 1;
alter table public.enrollments add column if not exists hld_target int not null default 1;
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'enrollments' and column_name = 'daily_target'
  ) then
    execute 'update public.enrollments set dsa_target = daily_target, lld_target = 0, hld_target = 0';
    execute 'alter table public.enrollments drop column daily_target';
  end if;
end $$;
alter table public.enrollments drop constraint if exists enrollments_targets_check;
alter table public.enrollments add constraint enrollments_targets_check
  check (
    dsa_target between 0 and 20 and
    lld_target between 0 and 10 and
    hld_target between 0 and 10 and
    dsa_target + lld_target + hld_target between 1 and 20
  );
-- ---------------------------------------------------------------------------
-- daily_logs — one row per user per calendar day (in the user's timezone)
--   active   : today, still in progress
--   complete : hit the daily target — green day
--   frozen   : target missed, but a streak freeze covered it — streak survives
--   missed   : target not met and no freeze available — red day
-- ---------------------------------------------------------------------------
create table if not exists public.daily_logs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(id) on delete cascade,
  log_date       date not null,
  required_count int  not null default 5,
  solved_count   int  not null default 0,
  dsa_required   int  not null default 0,
  lld_required   int  not null default 0,
  hld_required   int  not null default 0,
  dsa_solved     int  not null default 0,
  lld_solved     int  not null default 0,
  hld_solved     int  not null default 0,
  bonus_count    int  not null default 0,
  status         text not null default 'active' check (status in ('active', 'complete', 'missed', 'frozen')),
  closed_at      timestamptz,
  streak_warned_at timestamptz,
  red_alerted_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (user_id, log_date)
);

-- Widen the status check on databases created before freezes existed.
alter table public.daily_logs drop constraint if exists daily_logs_status_check;
alter table public.daily_logs add constraint daily_logs_status_check
  check (status in ('active', 'complete', 'missed', 'frozen'));
alter table public.daily_logs add column if not exists streak_warned_at timestamptz;
alter table public.daily_logs add column if not exists red_alerted_at timestamptz;
alter table public.daily_logs add column if not exists dsa_required int not null default 0;
alter table public.daily_logs add column if not exists lld_required int not null default 0;
alter table public.daily_logs add column if not exists hld_required int not null default 0;
alter table public.daily_logs add column if not exists dsa_solved int not null default 0;
alter table public.daily_logs add column if not exists lld_solved int not null default 0;
alter table public.daily_logs add column if not exists hld_solved int not null default 0;
update public.daily_logs
set dsa_required = required_count,
    dsa_solved = solved_count
where dsa_required = 0 and lld_required = 0 and hld_required = 0 and required_count > 0;

create index if not exists daily_logs_user_date_idx on public.daily_logs (user_id, log_date desc);

-- ---------------------------------------------------------------------------
-- daily_assignments — the problems handed out for a given day
--   carried_over marks a problem that came back from an earlier red day
--   round 1 is the day's target set; rounds 2+ are extra sets the user asked
--   for after clearing the day, and never count toward the target
-- ---------------------------------------------------------------------------
create table if not exists public.daily_assignments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  problem_id   uuid not null references public.problems(id) on delete cascade,
  assigned_on  date not null,
  position     int  not null default 0,
  round        int  not null default 1,
  carried_over boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (user_id, assigned_on, problem_id)
);

alter table public.daily_assignments add column if not exists round int not null default 1;

create index if not exists daily_assignments_user_date_idx on public.daily_assignments (user_id, assigned_on desc);
create index if not exists daily_assignments_problem_idx   on public.daily_assignments (user_id, problem_id);

-- ---------------------------------------------------------------------------
-- user_problems — solve state, one row per (user, problem)
--   is_bonus = solved outside the day's assigned set
-- ---------------------------------------------------------------------------
create table if not exists public.user_problems (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  problem_id    uuid not null references public.problems(id) on delete cascade,
  status        text not null default 'solved' check (status in ('solved', 'revisit')),
  solved_on     date not null,
  is_bonus      boolean not null default false,
  time_spent_min int,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, problem_id)
);

create index if not exists user_problems_user_idx      on public.user_problems (user_id);
create index if not exists user_problems_solved_on_idx on public.user_problems (user_id, solved_on desc);

-- ---------------------------------------------------------------------------
-- assessment_attempts / assessment_answers — immutable Optimus assessments
-- ---------------------------------------------------------------------------
create table if not exists public.assessment_attempts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(id) on delete cascade,
  problem_id     uuid not null references public.problems(id) on delete cascade,
  status         text not null default 'generating'
    check (status in ('generating', 'active', 'grading', 'passed', 'failed')),
  question_set   jsonb,
  score          int check (score between 0 and 10),
  model_version  text not null,
  prompt_version text not null,
  started_at     timestamptz,
  submitted_at   timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists assessment_attempts_one_open_idx
  on public.assessment_attempts (user_id, problem_id)
  where status in ('generating', 'active', 'grading');
create index if not exists assessment_attempts_user_idx
  on public.assessment_attempts (user_id, created_at desc);

create table if not exists public.assessment_answers (
  id           uuid primary key default gen_random_uuid(),
  attempt_id   uuid not null references public.assessment_attempts(id) on delete cascade,
  question_id  text not null,
  answer       jsonb not null,
  score        numeric(4,2),
  feedback     text,
  test_results jsonb,
  submitted_at timestamptz not null default now(),
  graded_at    timestamptz,
  unique (attempt_id, question_id)
);

create index if not exists assessment_answers_attempt_idx on public.assessment_answers (attempt_id);

-- ---------------------------------------------------------------------------
-- subscriptions / payment_webhook_events — Dodo billing state
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null unique references public.users(id) on delete cascade,
  provider                 text not null default 'dodo' check (provider = 'dodo'),
  plan                     text not null check (plan in ('monthly', 'annual')),
  status                   text not null default 'pending'
    check (status in ('pending', 'active', 'on_hold', 'paused', 'cancelled', 'failed', 'expired')),
  provider_customer_id     text,
  provider_subscription_id text unique,
  checkout_session_id      text,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table if not exists public.payment_webhook_events (
  id           text primary key,
  event_type   text not null,
  payload      jsonb not null,
  processed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- milestone_recaps — immutable analytics snapshots for every 50 solves
-- ---------------------------------------------------------------------------
create table if not exists public.milestone_recaps (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  milestone  int not null check (milestone >= 50 and milestone % 50 = 0),
  achieved_on date not null,
  snapshot    jsonb not null,
  viewed_at   timestamptz,
  emailed_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, milestone)
);
alter table public.milestone_recaps add column if not exists emailed_at timestamptz;

create index if not exists milestone_recaps_user_idx
  on public.milestone_recaps (user_id, milestone desc);

-- ---------------------------------------------------------------------------
-- streak_milestones — durable email state for each seven-day streak milestone
-- ---------------------------------------------------------------------------
create table if not exists public.streak_milestones (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  streak_length int not null check (streak_length >= 7 and streak_length % 7 = 0),
  achieved_on   date not null,
  emailed_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, streak_length, achieved_on)
);

create index if not exists streak_milestones_pending_idx
  on public.streak_milestones (emailed_at, created_at)
  where emailed_at is null;

create index if not exists streak_milestones_user_idx
  on public.streak_milestones (user_id, streak_length desc);

-- ---------------------------------------------------------------------------
-- waitlist — public signups from the landing page
-- ---------------------------------------------------------------------------
create table if not exists public.waitlist (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  name       text,
  referrer   text,
  created_at timestamptz not null default now()
);

create index if not exists waitlist_created_at_idx on public.waitlist (created_at);

-- ---------------------------------------------------------------------------
-- account_invites — one-time account creation links issued from the waitlist
-- ---------------------------------------------------------------------------
create table if not exists public.account_invites (
  id                  uuid primary key default gen_random_uuid(),
  waitlist_id         uuid not null references public.waitlist(id) on delete cascade,
  email               text not null,
  token_hash          text not null unique,
  expires_at          timestamptz not null,
  sent_at             timestamptz,
  used_at             timestamptz,
  revoked_at          timestamptz,
  welcome_sent_at     timestamptz,
  provider_message_id text,
  send_attempts       int not null default 0 check (send_attempts >= 0),
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists account_invites_waitlist_idx
  on public.account_invites (waitlist_id, created_at desc);
create index if not exists account_invites_email_idx
  on public.account_invites (lower(email), created_at desc);

-- Account creation and invite consumption share one transaction. Only the
-- service-role API may execute this function.
create or replace function public.accept_waitlist_invite(
  p_token_hash text,
  p_name text,
  p_password_hash text,
  p_timezone text,
  p_avatar_seed text
)
returns setof public.users
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invite public.account_invites%rowtype;
  created_user public.users%rowtype;
begin
  select * into invite
  from public.account_invites
  where token_hash = p_token_hash
    and used_at is null
    and revoked_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'Invite is invalid or expired' using errcode = 'P0001';
  end if;

  insert into public.users (email, password_hash, name, timezone, avatar_seed)
  values (invite.email, p_password_hash, p_name, p_timezone, p_avatar_seed)
  returning * into created_user;

  update public.account_invites
  set used_at = now(), updated_at = now()
  where id = invite.id;

  return next created_user;
end;
$$;

revoke all on function public.accept_waitlist_invite(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.accept_waitlist_invite(text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Row level security
-- The API talks to Postgres with the service-role key and authorizes every
-- request itself, so RLS stays on with no permissive policies for anon/auth.
-- ---------------------------------------------------------------------------
alter table public.users             enable row level security;
alter table public.refresh_tokens    enable row level security;
alter table public.enrollments       enable row level security;
alter table public.daily_logs        enable row level security;
alter table public.daily_assignments enable row level security;
alter table public.user_problems     enable row level security;
alter table public.milestone_recaps  enable row level security;
alter table public.streak_milestones enable row level security;
alter table public.problems          enable row level security;
alter table public.waitlist          enable row level security;
alter table public.account_invites    enable row level security;
alter table public.assessment_attempts   enable row level security;
alter table public.assessment_answers    enable row level security;
alter table public.subscriptions         enable row level security;
alter table public.payment_webhook_events enable row level security;

drop policy if exists "problems are publicly readable" on public.problems;
create policy "problems are publicly readable"
  on public.problems for select
  using (true);
