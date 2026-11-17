-- Finances tab: the chapter budget, copied from the Treasurer's Google Sheet.
-- Run after app.sql (it uses is_member()). Safe to run again.
--
-- Only the "Chapter Expenses" table is copied: each line's name, what was
-- budgeted and what was spent. sync/budget.mjs reads the Sheet as a robot
-- every few minutes (see supabase/schedule.sql) and replaces these rows.
-- Every signed-in brother can read them. Visitors, and the TV, can't.
-- Nobody writes them from the app; only the sync (service role) does.

create table if not exists public.budget_lines (
  name     text primary key check (char_length(name) between 1 and 80),
  budgeted numeric(12, 2) not null default 0,
  spent    numeric(12, 2) not null default 0,
  sort     integer not null default 0
);

-- One row: when the Sheet was last read, and whether that worked.
create table if not exists public.budget_sync (
  id        boolean primary key default true check (id),
  synced_at timestamptz,          -- the last successful read
  tried_at  timestamptz,          -- the last attempt, good or bad
  problem   text                  -- why the last attempt failed, or null
);

alter table public.budget_lines enable row level security;
alter table public.budget_sync enable row level security;

drop policy if exists "brothers read the budget" on public.budget_lines;
create policy "brothers read the budget" on public.budget_lines
  for select to authenticated using ((select public.is_member()));

drop policy if exists "brothers read when the budget synced" on public.budget_sync;
create policy "brothers read when the budget synced" on public.budget_sync
  for select to authenticated using ((select public.is_member()));

revoke all on public.budget_lines, public.budget_sync from anon, authenticated;
grant select on public.budget_lines, public.budget_sync to authenticated;
grant select, insert, update, delete on public.budget_lines, public.budget_sync to service_role;
