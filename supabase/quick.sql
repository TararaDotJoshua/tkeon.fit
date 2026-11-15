-- Quick access tab: the org chart and study hours.
-- Run after app.sql (it uses public.teams, public.profiles, is_member() and is_admin()).
-- Safe to run again.

-- ---------------------------------------------------------------------------
-- Org chart: where each position sits. 'head' is the box at the top, 'exec' the
-- executive board under it, 'chair' the chairmen. Committees don't use it.
-- Admins change it in Settings > Positions and committees.
-- ---------------------------------------------------------------------------
alter table public.teams add column if not exists chart text check (chart in ('head', 'exec', 'chair'));

-- First run only: sort the positions that exist by their titles. Positions an
-- admin has already placed (chart is set) are left alone.
update public.teams set chart = case
    when name ~* '^prytanis' then 'head'
    when name ~* '^(epiprytanis|grammateus|crysophylos|chrysophylos|histor|hypophetes|pylortes|hegemon)' then 'exec'
    else 'chair'
  end
where kind = 'position' and chart is null;

-- ---------------------------------------------------------------------------
-- Study hours: each brother logs his own. He sees only his own; admins see
-- everyone's. Nobody else, signed in or not, can read them.
-- ---------------------------------------------------------------------------
create table if not exists public.study_hours (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  day        date not null default current_date,
  minutes    integer not null check (minutes between 5 and 1440),
  place      text check (char_length(place) <= 80),
  note       text check (char_length(note) <= 300),
  created_at timestamptz not null default now()
);
create index if not exists study_hours_profile_day on public.study_hours (profile_id, day);
create index if not exists study_hours_day on public.study_hours (day);

alter table public.study_hours enable row level security;
revoke all on public.study_hours from anon, authenticated;
grant select, insert, update, delete on public.study_hours to authenticated;
grant select, insert, update, delete on public.study_hours to service_role;

drop policy if exists "own or admin read" on public.study_hours;
drop policy if exists "own insert" on public.study_hours;
drop policy if exists "own update" on public.study_hours;
drop policy if exists "own or admin delete" on public.study_hours;

create policy "own or admin read" on public.study_hours for select to authenticated
  using ((profile_id = (select auth.uid()) and public.is_member()) or public.is_admin());

-- Only for himself, only for today or the 30 days before (current_date is UTC,
-- which is never behind Florida, so "today" always works), never the future.
create policy "own insert" on public.study_hours for insert to authenticated
  with check (profile_id = (select auth.uid()) and public.is_member()
              and day <= current_date and day >= current_date - 30);
create policy "own update" on public.study_hours for update to authenticated
  using (profile_id = (select auth.uid()) and public.is_member())
  with check (profile_id = (select auth.uid()) and day <= current_date and day >= current_date - 30);
create policy "own or admin delete" on public.study_hours for delete to authenticated
  using ((profile_id = (select auth.uid()) and public.is_member()) or public.is_admin());
