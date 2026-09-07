-- Structured on-demand research briefs and private blog bookmarks.

create table if not exists public.blog_bookmarks (
  blog_id    uuid not null references public.blogs(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blog_id, user_id)
);

create index if not exists blog_bookmarks_user_idx on public.blog_bookmarks (user_id, created_at desc);
alter table public.blog_bookmarks enable row level security;

alter table public.blog_research_jobs add column if not exists brief jsonb not null default '{}'::jsonb;
