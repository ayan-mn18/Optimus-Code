-- Track login recency and one re-engagement email per inactive week.
alter table public.users add column if not exists last_login_at timestamptz;
alter table public.users add column if not exists last_activity_at timestamptz;

create table if not exists public.inactive_reminder_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  inactive_week   int not null,
  emailed_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_id, inactive_week)
);

create index if not exists inactive_reminder_events_user_idx
  on public.inactive_reminder_events (user_id, inactive_week desc);

alter table public.inactive_reminder_events enable row level security;
