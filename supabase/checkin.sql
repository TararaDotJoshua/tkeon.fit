-- Event check-in: an officer starts check-in on a calendar event and gets a
-- random code. With "Must be here" on (the default), a brother within about
-- 150 m of where the officer started it taps Check in here, no code needed;
-- with it off (online events), he types the code.
-- Run after app.sql and quick.sql. Safe to run again.
--
-- Nothing here stores anyone's location except the spot the officer started
-- check-in from (removed when check-in closes). A brother's position is only
-- compared, never saved.

-- ---------------------------------------------------------------------------
-- Event history: every calendar event the hourly sync has seen. public.events
-- only holds 2 days back to 15 days ahead; this keeps the past for attendance.
-- ---------------------------------------------------------------------------
create table if not exists public.event_history (
  id         text primary key,             -- same id as public.events: calendar UID + "|" + start
  title      text not null,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  all_day    boolean not null default false,
  location   text,
  removed_at timestamptz,                  -- taken off the calendar before it happened
  seen_at    timestamptz not null default now()
);
create index if not exists event_history_starts on public.event_history (starts_at);

-- ---------------------------------------------------------------------------
-- Who counts as an officer: an admin, or anyone holding a position (the
-- Greek-titled officers and the chairmen). Committees alone don't count.
-- ---------------------------------------------------------------------------
create or replace function public.is_officer() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_member() and (public.is_admin() or exists (
    select 1 from public.profile_teams pt join public.teams t on t.id = pt.team_id
    where pt.profile_id = (select auth.uid()) and t.kind = 'position' and t.archived_at is null));
$$;

-- ---------------------------------------------------------------------------
-- Check-in sessions (one per event) and attendance.
-- ---------------------------------------------------------------------------
create table if not exists public.checkin_sessions (
  event_id      text primary key references public.event_history (id) on delete cascade,
  code          text not null,
  need_location boolean not null default true,
  lat           double precision,           -- where the officer started it; cleared when it closes
  lng           double precision,
  accuracy_m    real,
  opened_by     uuid references public.profiles (id) on delete set null,
  opened_at     timestamptz not null default now(),
  closes_at     timestamptz not null,
  closed_at     timestamptz
);

create table if not exists public.attendance (
  event_id      text not null references public.event_history (id) on delete cascade,
  profile_id    uuid not null references public.profiles (id) on delete cascade,
  checked_in_at timestamptz not null default now(),
  method        text not null check (method in ('code', 'here', 'added')),
  added_by      uuid references public.profiles (id) on delete set null,
  primary key (event_id, profile_id)
);
create index if not exists attendance_profile on public.attendance (profile_id);
-- 'here' (checked in by location, no code) was added after the table first went live.
alter table public.attendance drop constraint if exists attendance_method_check;
alter table public.attendance add constraint attendance_method_check check (method in ('code', 'here', 'added'));

-- Wrong codes, so nobody can guess his way in (kept a day).
create table if not exists private.checkin_misses (
  profile_id uuid not null,
  at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Rules. Anyone may read event history (the calendar is public already).
-- Attendance: a brother reads his own; officers read everyone's. Nobody writes
-- these tables directly; the functions below do, after checking.
-- ---------------------------------------------------------------------------
alter table public.event_history    enable row level security;
alter table public.checkin_sessions enable row level security;
alter table public.attendance       enable row level security;
revoke all on public.event_history, public.checkin_sessions, public.attendance from anon, authenticated;
grant select on public.event_history to anon, authenticated;
grant select on public.attendance to authenticated;
grant select, insert, update, delete on public.event_history, public.checkin_sessions, public.attendance to service_role;

drop policy if exists "read" on public.event_history;
create policy "read" on public.event_history for select to anon, authenticated using (true);
drop policy if exists "own or officer read" on public.attendance;
create policy "own or officer read" on public.attendance for select to authenticated
  using ((profile_id = (select auth.uid()) and public.is_member()) or public.is_officer());
-- checkin_sessions has no policies at all: only the functions below reach it.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Four characters that can't be misread: no 0/O, 1/I/L, 2/Z, 5/S, 8/B.
create or replace function private.checkin_new_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  abc constant text := 'ACDEFGHJKMNPQRTUVWXY34679';
  b bytea;
  c text;
begin
  loop
    b := extensions.gen_random_bytes(4);
    c := '';
    for i in 0..3 loop
      c := c || substr(abc, (get_byte(b, i) % length(abc)) + 1, 1);
    end loop;
    -- unique among check-ins open right now, since a brother types only the code
    exit when not exists (select 1 from public.checkin_sessions s where s.code = c and s.closed_at is null and s.closes_at > now());
  end loop;
  return c;
end $$;

-- Metres between two points (haversine).
create or replace function private.metres(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable set search_path = '' as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- The event, from the calendar window or from history; copied into history so
-- attendance can point at it.
create or replace function private.checkin_event(p_event text) returns public.event_history
language plpgsql volatile set search_path = '' as $$
declare
  e public.event_history;
begin
  insert into public.event_history (id, title, starts_at, ends_at, all_day, location)
  select ev.id, ev.title, ev.starts_at, ev.ends_at, ev.all_day, ev.location from public.events ev where ev.id = p_event
  on conflict (id) do update set title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
    all_day = excluded.all_day, location = excluded.location, removed_at = null;
  select * into e from public.event_history where id = p_event;
  if not found then raise exception 'no_event'; end if;
  return e;
end $$;

create or replace function private.checkin_status_of(p_event text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'open', s.closed_at is null and s.closes_at > now(),
    'code', case when s.closed_at is null and s.closes_at > now() then s.code end,
    'need_location', s.need_location,
    'closes_at', s.closes_at,
    'opened_at', s.opened_at,
    'count', (select count(*) from public.attendance a where a.event_id = p_event))
  from public.checkin_sessions s where s.event_id = p_event;
$$;

-- ---------------------------------------------------------------------------
-- Officers
-- ---------------------------------------------------------------------------

-- Start check-in (or get the open one). Allowed from 3 hours before the event
-- until it ends; it stays open until 30 minutes after the end.
create or replace function public.checkin_start(p_event text, p_need_location boolean,
  p_lat double precision default null, p_lng double precision default null, p_accuracy double precision default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e public.event_history;
  s public.checkin_sessions;
begin
  if not public.is_officer() then raise exception 'officers_only'; end if;
  e := private.checkin_event(p_event);
  if now() < e.starts_at - interval '3 hours' then raise exception 'too_early'; end if;
  if now() > e.ends_at then raise exception 'event_over'; end if;
  if p_need_location and (p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180) then
    raise exception 'need_location';
  end if;
  select * into s from public.checkin_sessions where event_id = p_event;
  if found and s.closed_at is null and s.closes_at > now() then
    return private.checkin_status_of(p_event); -- already open: everyone sees the same code
  end if;
  insert into public.checkin_sessions (event_id, code, need_location, lat, lng, accuracy_m, opened_by, opened_at, closes_at, closed_at)
  values (p_event, private.checkin_new_code(), p_need_location,
          case when p_need_location then p_lat end, case when p_need_location then p_lng end,
          case when p_need_location then least(p_accuracy, 5000) end,
          (select auth.uid()), now(), e.ends_at + interval '30 minutes', null)
  on conflict (event_id) do update set code = excluded.code, need_location = excluded.need_location, lat = excluded.lat,
    lng = excluded.lng, accuracy_m = excluded.accuracy_m, opened_by = excluded.opened_by, opened_at = excluded.opened_at,
    closes_at = excluded.closes_at, closed_at = null;
  return private.checkin_status_of(p_event);
end $$;

create or replace function public.checkin_status(p_event text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_officer() then raise exception 'officers_only'; end if;
  return coalesce(private.checkin_status_of(p_event),
    jsonb_build_object('open', false, 'count', (select count(*) from public.attendance a where a.event_id = p_event)));
end $$;

-- A new code (the old one stops working at once), the location check on or
-- off (on needs a fresh spot), or close check-in.
create or replace function public.checkin_change(p_event text, p_action text,
  p_lat double precision default null, p_lng double precision default null, p_accuracy double precision default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_officer() then raise exception 'officers_only'; end if;
  if not exists (select 1 from public.checkin_sessions where event_id = p_event and closed_at is null and closes_at > now()) then
    raise exception 'not_open';
  end if;
  if p_action = 'new_code' then
    update public.checkin_sessions set code = private.checkin_new_code() where event_id = p_event;
  elsif p_action = 'location_off' then
    update public.checkin_sessions set need_location = false, lat = null, lng = null, accuracy_m = null where event_id = p_event;
  elsif p_action = 'location_on' then
    if p_lat is null or p_lng is null then raise exception 'need_location'; end if;
    update public.checkin_sessions set need_location = true, lat = p_lat, lng = p_lng, accuracy_m = least(p_accuracy, 5000) where event_id = p_event;
  elsif p_action = 'close' then
    update public.checkin_sessions set closed_at = now(), lat = null, lng = null, accuracy_m = null where event_id = p_event;
  else
    raise exception 'bad_action';
  end if;
  return private.checkin_status_of(p_event);
end $$;

-- Add a brother by hand (phone died, no signal), or take a check-in off.
create or replace function public.attendance_add(p_event text, p_profile uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_officer() then raise exception 'officers_only'; end if;
  if not exists (select 1 from public.event_history where id = p_event) then perform private.checkin_event(p_event); end if;
  if not exists (select 1 from public.profiles where id = p_profile and not disabled) then raise exception 'no_member'; end if;
  insert into public.attendance (event_id, profile_id, method, added_by)
  values (p_event, p_profile, 'added', (select auth.uid())) on conflict do nothing;
end $$;

create or replace function public.attendance_remove(p_event text, p_profile uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_officer() then raise exception 'officers_only'; end if;
  delete from public.attendance where event_id = p_event and profile_id = p_profile;
end $$;

-- ---------------------------------------------------------------------------
-- Brothers
-- ---------------------------------------------------------------------------

-- Events with check-in open right now: titles only, never the code.
create or replace function public.checkin_open_now() returns table (event_id text, title text, starts_at timestamptz, need_location boolean)
language sql stable security definer set search_path = '' as $$
  select e.id, e.title, e.starts_at, s.need_location
  from public.checkin_sessions s join public.event_history e on e.id = s.event_id
  where public.is_member() and s.closed_at is null and s.closes_at > now()
  order by e.starts_at;
$$;

-- Check in with the code, and the phone's location if the event needs it.
create or replace function public.check_in(p_code text,
  p_lat double precision default null, p_lng double precision default null, p_accuracy double precision default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  s public.checkin_sessions;
  e public.event_history;
  allowed double precision;
  dist double precision;
  was boolean;
begin
  if not public.is_member() then raise exception 'members_only'; end if;
  delete from private.checkin_misses where at < now() - interval '1 day';
  if (select count(*) from private.checkin_misses where profile_id = me and at > now() - interval '15 minutes') >= 8 then
    raise exception 'too_many_tries';
  end if;
  select * into s from public.checkin_sessions where code = c and closed_at is null and closes_at > now();
  if not found then
    -- Returned, not raised: raising would roll back the record of this miss.
    insert into private.checkin_misses (profile_id) values (me);
    return jsonb_build_object('error', 'bad_code');
  end if;
  select * into e from public.event_history where id = s.event_id;
  was := exists (select 1 from public.attendance where event_id = s.event_id and profile_id = me);
  if not was and s.need_location then
    if p_lat is null or p_lng is null then raise exception 'need_location'; end if;
    if p_accuracy is not null and p_accuracy > 1000 then raise exception 'location_vague'; end if;
    -- 150 m, plus some slack for how unsure each phone was (GPS indoors is rough)
    allowed := 150 + least(coalesce(p_accuracy, 0), 150) + least(coalesce(s.accuracy_m, 0), 150);
    dist := private.metres(s.lat, s.lng, p_lat, p_lng);
    if dist > allowed then raise exception 'too_far:%', round(dist)::int; end if;
  end if;
  if not was then
    insert into public.attendance (event_id, profile_id, method) values (s.event_id, me, 'code');
  end if;
  return jsonb_build_object('event_id', e.id, 'title', e.title, 'starts_at', e.starts_at, 'all_day', e.all_day, 'already', was);
end $$;

-- Check in by being there: no code. Only for events with "Must be here" on;
-- picks the open check-in nearest the brother (or the one he chose, p_event)
-- and applies the same distance rule as check_in(). Online events, with the
-- location check off, still need the code.
create or replace function public.check_in_here(p_lat double precision, p_lng double precision,
  p_accuracy double precision default null, p_event text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  v_event text;
  v_dist double precision;
  v_allowed double precision;
  e public.event_history;
  was boolean;
begin
  if not public.is_member() then raise exception 'members_only'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then raise exception 'need_location'; end if;
  if p_accuracy is not null and p_accuracy > 1000 then raise exception 'location_vague'; end if;
  select s.event_id, private.metres(s.lat, s.lng, p_lat, p_lng),
         150 + least(coalesce(p_accuracy, 0), 150) + least(coalesce(s.accuracy_m, 0), 150)
    into v_event, v_dist, v_allowed
  from public.checkin_sessions s
  where s.closed_at is null and s.closes_at > now() and s.need_location and s.lat is not null
    and (p_event is null or s.event_id = p_event)
  order by private.metres(s.lat, s.lng, p_lat, p_lng)
  limit 1;
  if v_event is null then raise exception 'none_open'; end if;
  if v_dist > v_allowed then raise exception 'too_far:%', round(v_dist)::int; end if;
  select * into e from public.event_history where id = v_event;
  was := exists (select 1 from public.attendance where event_id = v_event and profile_id = me);
  if not was then
    insert into public.attendance (event_id, profile_id, method) values (v_event, me, 'here');
  end if;
  return jsonb_build_object('event_id', e.id, 'title', e.title, 'starts_at', e.starts_at, 'all_day', e.all_day, 'already', was);
end $$;

-- ---------------------------------------------------------------------------
-- Who may call what. Supabase grants new functions to everyone by default.
-- ---------------------------------------------------------------------------
revoke execute on function public.is_officer(), public.checkin_start(text, boolean, double precision, double precision, double precision),
  public.checkin_status(text), public.checkin_change(text, text, double precision, double precision, double precision),
  public.attendance_add(text, uuid), public.attendance_remove(text, uuid), public.checkin_open_now(),
  public.check_in(text, double precision, double precision, double precision),
  public.check_in_here(double precision, double precision, double precision, text),
  private.checkin_new_code(), private.metres(double precision, double precision, double precision, double precision),
  private.checkin_event(text), private.checkin_status_of(text)
  from public, anon, authenticated;
grant execute on function public.is_officer() to anon, authenticated, service_role;
grant execute on function public.checkin_start(text, boolean, double precision, double precision, double precision),
  public.checkin_status(text), public.checkin_change(text, text, double precision, double precision, double precision),
  public.attendance_add(text, uuid), public.attendance_remove(text, uuid), public.checkin_open_now(),
  public.check_in(text, double precision, double precision, double precision),
  public.check_in_here(double precision, double precision, double precision, text) to authenticated;
