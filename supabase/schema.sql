-- Omicron Nu dashboard (tkeon.fit/Dashboard)
-- Run this once in the Supabase SQL editor. It is safe to run again.
--
-- Who can do what:
--   anon key (in the page)          SELECT only, through the policies below.
--   service-role key (Actions only) bypasses RLS; the hourly sync writes with it.

-- KRA rows, one per item on nationals' KRA page --------------------------------
create table if not exists public.kras (
  id          text primary key,                 -- section-slug(name), e.g. kra-st-jude-dollars
  section     text not null check (section in ('kra', 'required', 'bonus')),
  name        text not null,
  kind        text not null default 'number' check (kind in ('number', 'currency', 'boolean')),
  result_text text,                             -- raw value from nationals: "$165.00", "False", "N/A"
  goal_text   text,                             -- raw goal; blank when nationals shows none
  current     numeric,                          -- parsed result; null when N/A or blank
  goal        numeric,                          -- parsed goal; null when N/A or blank
  points      numeric,                          -- points earned
  out_of      numeric,                          -- points possible
  met         boolean,                          -- nationals' green/red dot
  sort_order  integer not null default 0,
  -- Hand-edited. The sync never writes these three.
  term_start  date,                             -- start of the window for the pace marker
  due_date    date,                             -- end of the window for the pace marker
  note        text,
  updated_at  timestamptz not null default now()
);

-- Calendar events in a rolling window around today ---------------------------
-- For all-day rows, starts_at/ends_at hold the calendar date at 00:00 UTC and
-- ends_at is exclusive (iCal style). The page reads them as dates, not instants.
create table if not exists public.events (
  id        text primary key,                   -- calendar UID + "|" + start time
  title     text not null,
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  all_day   boolean not null default false,
  location  text
);
create index if not exists events_starts_at_idx on public.events (starts_at);

-- One row per sync run; the page shows "Updated …" and stale/failed notices -----
create table if not exists public.sync_runs (
  id      bigint generated always as identity primary key,
  ran_at  timestamptz not null default now(),
  ok      boolean not null,
  message text
);
create index if not exists sync_runs_ran_at_idx on public.sync_runs (ran_at desc);

-- Daily history for trend lines (one row per KRA per chapter-local day) ------
-- No foreign key on purpose: history stays when nationals drops a KRA.
create table if not exists public.kra_snapshots (
  day     date not null,
  kra_id  text not null,
  current numeric,
  points  numeric,
  primary key (day, kra_id)
);

-- Read-only access for the page ------------------------------------------------
alter table public.kras          enable row level security;
alter table public.events        enable row level security;
alter table public.sync_runs     enable row level security;
alter table public.kra_snapshots enable row level security;

drop policy if exists "public read" on public.kras;
drop policy if exists "public read" on public.events;
drop policy if exists "public read" on public.sync_runs;
drop policy if exists "public read" on public.kra_snapshots;

create policy "public read" on public.kras          for select to anon, authenticated using (true);
create policy "public read" on public.events        for select to anon, authenticated using (true);
create policy "public read" on public.sync_runs     for select to anon, authenticated using (true);
create policy "public read" on public.kra_snapshots for select to anon, authenticated using (true);

-- Explicit grants, so this works whether or not the project "automatically
-- exposes new tables": the page's key may only read; the sync's key may write.
grant usage on schema public to anon, authenticated, service_role;
grant select on public.kras, public.events, public.sync_runs, public.kra_snapshots to anon, authenticated;
grant select, insert, update, delete on public.kras, public.events, public.sync_runs, public.kra_snapshots to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Belt and braces: with no write policies RLS already refuses writes, and these
-- revokes make the anon key fail before RLS is even checked.
revoke insert, update, delete, truncate on public.kras          from anon, authenticated;
revoke insert, update, delete, truncate on public.events        from anon, authenticated;
revoke insert, update, delete, truncate on public.sync_runs     from anon, authenticated;
revoke insert, update, delete, truncate on public.kra_snapshots from anon, authenticated;
