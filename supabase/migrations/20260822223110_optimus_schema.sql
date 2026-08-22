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
  password_hash text not null,
  name          text not null,
  timezone      text not null default 'UTC',
  avatar_seed   text not null default 'optimus',
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
  slug         text not null unique,
  title        text not null,
  topic        text not null,
  difficulty   text not null check (difficulty in ('Easy', 'Medium', 'Hard')),
  leetcode_url text,
  youtube_url  text,
  article_url  text,
  source       text not null default 'Striver SDE Sheet',
  order_index  int  not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists problems_topic_idx      on public.problems (topic);
create index if not exists problems_difficulty_idx on public.problems (difficulty);

-- ---------------------------------------------------------------------------
-- enrollments — a user signing up for the daily challenge
-- ---------------------------------------------------------------------------
create table if not exists public.enrollments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  daily_target int  not null default 5 check (daily_target between 1 and 20),
  status       text not null default 'active' check (status in ('active', 'paused')),
  started_on   date not null,
  created_at   timestamptz not null default now(),
  unique (user_id)
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
  bonus_count    int  not null default 0,
  status         text not null default 'active' check (status in ('active', 'complete', 'missed', 'frozen')),
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  unique (user_id, log_date)
);

-- Widen the status check on databases created before freezes existed.
alter table public.daily_logs drop constraint if exists daily_logs_status_check;
alter table public.daily_logs add constraint daily_logs_status_check
  check (status in ('active', 'complete', 'missed', 'frozen'));

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
-- milestone_recaps — immutable analytics snapshots for every 50 solves
-- ---------------------------------------------------------------------------
create table if not exists public.milestone_recaps (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  milestone  int not null check (milestone >= 50 and milestone % 50 = 0),
  achieved_on date not null,
  snapshot    jsonb not null,
  viewed_at   timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, milestone)
);

create index if not exists milestone_recaps_user_idx
  on public.milestone_recaps (user_id, milestone desc);

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
alter table public.problems          enable row level security;
alter table public.waitlist          enable row level security;

drop policy if exists "problems are publicly readable" on public.problems;
create policy "problems are publicly readable"
  on public.problems for select
  using (true);
