-- Goals tab and task board: accounts, profiles, goals and the board.
-- Run after schema.sql, in the Supabase SQL editor. It is safe to run again.
--
-- Who can do what:
--   anyone (not signed in)  reads goals, the board, positions, committees and
--                           members' public profiles. Changes nothing.
--   signed-in member        also creates, edits, moves and archives goals and
--                           issues, adds check-ins, edits their own profile.
--   admin                   also manages positions and committees, who holds
--                           them, board columns, custom fields and accounts.
--
-- Sign-in is FIT email + scroll number. Supabase needs passwords of 6+
-- characters, so the page pads the scroll number (see private.scroll_password).
-- The digital scroll and sign-in emails are never readable through the API:
-- they live in the `private` and `auth` schemas, which the API does not expose.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Private data
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- The digital scroll: one row per initiate. Loaded by hand, never from the repo.
create table if not exists private.scroll (
  number     integer primary key,
  name       text,
  claimed_by uuid unique references auth.users (id) on delete set null,
  claimed_at timestamptz
);

-- key 'admin_emails': comma-separated, lower-case emails that become admins at sign-up.
create table if not exists private.settings (
  key   text primary key,
  value text not null
);

-- The password Supabase stores for a scroll number. The page builds the same string.
create or replace function private.scroll_password(n integer) returns text
language sql immutable set search_path = '' as $$
  select 'tkeon-scroll-' || n::text;
$$;

create or replace function private.fit_email(e text) returns boolean
language sql immutable set search_path = '' as $$
  select e is not null and lower(e) ~ '^[a-z0-9._%+-]+@(my\.)?fit\.edu$';
$$;

-- ---------------------------------------------------------------------------
-- Public tables
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null default '' check (char_length(name) <= 80),
  grad_year   integer check (grad_year between 1950 and 2100),
  avatar_path text check (avatar_path is null or char_length(avatar_path) <= 200),
  is_admin    boolean not null default false,
  disabled    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('position', 'committee')),
  name        text not null check (char_length(name) between 1 and 80),
  sort        integer not null default 0,
  archived_at timestamptz
);

create table if not exists public.profile_teams (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  team_id    uuid not null references public.teams (id) on delete cascade,
  primary key (profile_id, team_id)
);

create table if not exists public.goals (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (char_length(title) between 1 and 160),
  description   text check (description is null or char_length(description) <= 2000),
  why           text check (why is null or char_length(why) <= 2000),
  unit          text not null default 'number' check (unit in ('number', 'currency', 'percent', 'boolean')),
  start_value   numeric not null default 0,
  target_value  numeric not null,
  current_value numeric,                        -- set by check-ins; ignored when kra_id is set
  kra_id        text,                           -- optional: follow this row of public.kras
  owner_team_id uuid references public.teams (id) on delete set null,
  start_date    date not null default current_date,
  due_date      date not null,
  status        text not null default 'active' check (status in ('active', 'achieved', 'dropped')),
  archived_at   timestamptz,
  created_by    uuid references public.profiles (id) on delete set null,
  updated_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (due_date >= start_date)
);

create table if not exists public.goal_checkins (
  id         uuid primary key default gen_random_uuid(),
  goal_id    uuid not null references public.goals (id) on delete cascade,
  value      numeric not null,
  note       text check (note is null or char_length(note) <= 500),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists goal_checkins_goal_idx on public.goal_checkins (goal_id, created_at);

create table if not exists public.board_columns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 40),
  sort        integer not null default 0,
  is_done     boolean not null default false,
  archived_at timestamptz
);

-- Document links are [{ "label": "...", "url": "https://..." }]; only http(s) is allowed.
create or replace function public.valid_links(j jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(j) = 'array' and jsonb_array_length(j) <= 20 and not exists (
    select 1 from jsonb_array_elements(j) e
    where jsonb_typeof(e) <> 'object' or coalesce(e ->> 'url', '') !~* '^https?://[^\s]+$' or char_length(e ->> 'url') > 2000 or char_length(coalesce(e ->> 'label', '')) > 120
  );
$$;

create table if not exists public.issues (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 160),
  description text check (description is null or char_length(description) <= 4000),
  column_id   uuid not null references public.board_columns (id),
  sort        double precision not null default 0,
  goal_id     uuid references public.goals (id) on delete set null,
  due_date    date,
  links       jsonb not null default '[]'::jsonb check (public.valid_links(links)),
  custom      jsonb not null default '{}'::jsonb check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) < 20000),
  archived_at timestamptz,
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists issues_column_idx on public.issues (column_id, sort);

create table if not exists public.issue_teams (
  issue_id uuid not null references public.issues (id) on delete cascade,
  team_id  uuid not null references public.teams (id) on delete cascade,
  primary key (issue_id, team_id)
);

create table if not exists public.custom_fields (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 40),
  type         text not null check (type in ('text', 'number', 'date', 'link', 'select', 'checkbox')),
  options      jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  sort         integer not null default 0,
  show_on_card boolean not null default false,
  archived_at  timestamptz
);

-- Who changed what. Written only by the triggers below.
create table if not exists public.activity (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  actor     uuid references public.profiles (id) on delete set null,
  entity    text not null,
  entity_id uuid not null,
  action    text not null,
  summary   text
);
create index if not exists activity_entity_idx on public.activity (entity, entity_id, at desc);

-- ---------------------------------------------------------------------------
-- Role checks (used by the access rules)
-- ---------------------------------------------------------------------------
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and not p.disabled);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin and not p.disabled);
$$;

-- ---------------------------------------------------------------------------
-- Sign-up: only a FIT email with a real, unclaimed scroll number gets in
-- ---------------------------------------------------------------------------
create or replace function private.before_auth_user_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
  s private.scroll%rowtype;
begin
  if tg_op = 'INSERT' then
    if not private.fit_email(new.email) then
      raise exception 'signup_bad_domain';
    end if;
    begin
      n := (new.raw_user_meta_data ->> 'scroll')::integer;
    exception when others then
      n := null;
    end;
    if n is null then
      raise exception 'signup_unknown_scroll';
    end if;
    select * into s from private.scroll where number = n for update;
    if not found then
      raise exception 'signup_unknown_scroll';
    end if;
    if s.claimed_by is not null then
      raise exception 'signup_scroll_claimed';
    end if;
    -- The stored password must be the one built from this scroll number.
    if new.encrypted_password is null
       or extensions.crypt(private.scroll_password(n), new.encrypted_password) <> new.encrypted_password then
      raise exception 'signup_password_mismatch';
    end if;
    -- Hand the number to the after-insert trigger, for this transaction only.
    perform set_config('tkeon.signup_scroll', n::text, true);
  end if;
  -- The scroll number is the password: never keep it in the account's metadata.
  if new.raw_user_meta_data ? 'scroll' then
    new.raw_user_meta_data := new.raw_user_meta_data - 'scroll';
  end if;
  return new;
end;
$$;

create or replace function private.after_auth_user_created() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n      integer := nullif(current_setting('tkeon.signup_scroll', true), '')::integer;
  nm     text;
  admins text;
begin
  if n is null then
    raise exception 'signup_unknown_scroll';
  end if;
  update private.scroll set claimed_by = new.id, claimed_at = now()
  where number = n and claimed_by is null
  returning name into nm;
  if not found then
    raise exception 'signup_scroll_claimed';
  end if;
  perform set_config('tkeon.signup_scroll', '', true);
  select value into admins from private.settings where key = 'admin_emails';
  insert into public.profiles (id, name, is_admin)
  values (new.id, coalesce(nm, ''), lower(new.email) = any (string_to_array(coalesce(admins, ''), ',')));
  return new;
end;
$$;

drop trigger if exists tkeon_on_auth_user_created on auth.users;
drop trigger if exists tkeon_before_auth_user_write on auth.users;
create trigger tkeon_before_auth_user_write
  before insert or update on auth.users
  for each row execute function private.before_auth_user_write();
drop trigger if exists tkeon_after_auth_user_created on auth.users;
create trigger tkeon_after_auth_user_created
  after insert on auth.users
  for each row execute function private.after_auth_user_created();

-- What the sign-in form should do with this email and scroll number.
-- It does reveal whether an email has an account and whether a scroll number is
-- free; neither is a secret in this chapter, and it lets the form say what's wrong.
create or replace function public.signin_state(p_email text, p_scroll text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  n integer;
  s private.scroll%rowtype;
begin
  if not private.fit_email(p_email) then
    return 'bad_domain';
  end if;
  if exists (select 1 from auth.users u where lower(u.email) = lower(p_email)) then
    return 'has_account';
  end if;
  if p_scroll !~ '^\d{1,6}$' then
    return 'unknown_scroll';
  end if;
  n := p_scroll::integer;
  select * into s from private.scroll where number = n;
  if not found then
    return 'unknown_scroll';
  end if;
  if s.claimed_by is not null then
    return 'scroll_claimed';
  end if;
  return 'can_join';
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin actions
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_member(p_id uuid, p_is_admin boolean, p_disabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'admins only';
  end if;
  if p_id = (select auth.uid()) and (p_disabled or not p_is_admin) then
    raise exception 'You can''t remove your own admin access.';
  end if;
  update public.profiles set is_admin = p_is_admin, disabled = p_disabled where id = p_id;
end;
$$;

-- Wipes the account so the brother can sign up again with his scroll number.
create or replace function public.admin_reset_member(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'admins only';
  end if;
  if p_id = (select auth.uid()) then
    raise exception 'You can''t reset your own account.';
  end if;
  update private.scroll set claimed_at = null where claimed_by = p_id;
  delete from auth.users where id = p_id; -- cascades to the profile; frees the scroll number
end;
$$;

-- ---------------------------------------------------------------------------
-- Bookkeeping triggers: who and when, check-ins, activity
-- ---------------------------------------------------------------------------
create or replace function private.stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Changes made by the database itself (clearing created_by when an account
  -- is deleted, a check-in updating the current value) aren't a member's edit.
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := (select auth.uid());
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists stamp on public.goals;
create trigger stamp before insert or update on public.goals for each row execute function private.stamp();
drop trigger if exists stamp on public.issues;
create trigger stamp before insert or update on public.issues for each row execute function private.stamp();

create or replace function private.on_checkin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_by := (select auth.uid());
  new.created_at := now();
  update public.goals set current_value = new.value where id = new.goal_id;
  return new;
end;
$$;
drop trigger if exists on_checkin on public.goal_checkins;
create trigger on_checkin before insert on public.goal_checkins for each row execute function private.on_checkin();

create or replace function private.log_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n    jsonb := to_jsonb(new);
  o    jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  act  text := 'updated';
  what text := n ->> 'title';
  quiet text[] := array['updated_at', 'updated_by'];
begin
  if tg_table_name = 'goal_checkins' then
    insert into public.activity (actor, entity, entity_id, action, summary)
    values ((select auth.uid()), 'goal', (n ->> 'goal_id')::uuid, 'check-in', (n ->> 'value') || coalesce(' · ' || (n ->> 'note'), ''));
    return new;
  end if;
  if pg_trigger_depth() > 1 then
    return new; -- a change made by the database itself, not by a member
  end if;
  if tg_op = 'INSERT' then
    act := 'created';
  elsif (n ->> 'archived_at') is not null and (o ->> 'archived_at') is null then
    act := 'archived';
  elsif (n ->> 'archived_at') is null and (o ->> 'archived_at') is not null then
    act := 'restored';
  elsif tg_table_name = 'issues' and (n ->> 'column_id') is distinct from (o ->> 'column_id') then
    act := 'moved';
    what := what || ' → ' || coalesce((select c.name from public.board_columns c where c.id = (n ->> 'column_id')::uuid), '?');
  elsif (n - quiet - 'sort') = (o - quiet - 'sort') then
    return new; -- reordering within a column isn't worth a log line
  elsif (n - quiet - 'current_value') = (o - quiet - 'current_value') then
    return new; -- the check-in already logged it
  end if;
  insert into public.activity (actor, entity, entity_id, action, summary)
  values ((select auth.uid()), case tg_table_name when 'goals' then 'goal' else 'issue' end, (n ->> 'id')::uuid, act, what);
  return new;
end;
$$;
drop trigger if exists log_activity on public.goals;
create trigger log_activity after insert or update on public.goals for each row execute function private.log_activity();
drop trigger if exists log_activity on public.issues;
create trigger log_activity after insert or update on public.issues for each row execute function private.log_activity();
drop trigger if exists log_activity on public.goal_checkins;
create trigger log_activity after insert on public.goal_checkins for each row execute function private.log_activity();

-- ---------------------------------------------------------------------------
-- Access rules
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['profiles', 'teams', 'profile_teams', 'goals', 'goal_checkins', 'board_columns', 'issues', 'issue_teams', 'custom_fields', 'activity'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('create policy "read" on public.%I for select to anon, authenticated using (true)', t);
    execute format('drop policy if exists "member insert" on public.%I', t);
    execute format('drop policy if exists "member update" on public.%I', t);
    execute format('drop policy if exists "member delete" on public.%I', t);
    execute format('drop policy if exists "admin insert" on public.%I', t);
    execute format('drop policy if exists "admin update" on public.%I', t);
    execute format('drop policy if exists "admin delete" on public.%I', t);
    execute format('drop policy if exists "own update" on public.%I', t);
  end loop;
end $$;

-- Members: goals, issues, check-ins, issue assignments. Nothing is ever deleted
-- except an assignment (a row in issue_teams); goals and issues are archived.
grant insert, update on public.goals, public.issues to authenticated;
grant insert on public.goal_checkins to authenticated;
grant insert, delete on public.issue_teams to authenticated;
create policy "member insert" on public.goals         for insert to authenticated with check (public.is_member());
create policy "member update" on public.goals         for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "member insert" on public.issues        for insert to authenticated with check (public.is_member());
create policy "member update" on public.issues        for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "member insert" on public.goal_checkins for insert to authenticated with check (public.is_member());
create policy "member insert" on public.issue_teams   for insert to authenticated with check (public.is_member());
create policy "member delete" on public.issue_teams   for delete to authenticated using (public.is_member());

-- Members edit only these columns of their own profile. is_admin and disabled
-- change only through admin_set_member().
grant update (name, grad_year, avatar_path) on public.profiles to authenticated;
create policy "own update" on public.profiles for update to authenticated
  using (id = (select auth.uid()) and public.is_member()) with check (id = (select auth.uid()));

-- Admins: positions and committees, who holds them, columns, custom fields.
grant insert, update on public.teams, public.board_columns, public.custom_fields to authenticated;
grant insert, delete on public.profile_teams to authenticated;
create policy "admin insert" on public.teams         for insert to authenticated with check (public.is_admin());
create policy "admin update" on public.teams         for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin insert" on public.board_columns for insert to authenticated with check (public.is_admin());
create policy "admin update" on public.board_columns for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin insert" on public.custom_fields for insert to authenticated with check (public.is_admin());
create policy "admin update" on public.custom_fields for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin insert" on public.profile_teams for insert to authenticated with check (public.is_admin());
create policy "admin delete" on public.profile_teams for delete to authenticated using (public.is_admin());

-- Functions: nothing callable by default, then open exactly what the page needs.
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.is_member(), public.is_admin(), public.signin_state(text, text),
  public.admin_set_member(uuid, boolean, boolean), public.admin_reset_member(uuid) from public, anon, authenticated;
grant execute on function public.is_member(), public.is_admin(), public.valid_links(jsonb) to anon, authenticated, service_role;
grant execute on function public.signin_state(text, text) to anon, authenticated;
grant execute on function public.admin_set_member(uuid, boolean, boolean), public.admin_reset_member(uuid) to authenticated;
grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Profile photos: a public bucket; each member writes only inside their own folder
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars: own folder insert" on storage.objects;
drop policy if exists "avatars: own folder update" on storage.objects;
drop policy if exists "avatars: own folder delete" on storage.objects;
drop policy if exists "avatars: own folder read" on storage.objects;
create policy "avatars: own folder insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text and public.is_member());
create policy "avatars: own folder update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatars: own folder delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatars: own folder read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- Starting lists (only when the tables are empty)
-- ---------------------------------------------------------------------------
insert into public.board_columns (name, sort, is_done)
select v.name, v.sort, v.is_done
from (values ('Backlog', 10, false), ('To do', 20, false), ('Doing', 30, false), ('Done', 40, true)) as v (name, sort, is_done)
where not exists (select 1 from public.board_columns);

-- Officer positions as my.tke.org lists them. Committees start empty; admins add them.
insert into public.teams (kind, name, sort)
select 'position', v.name, v.sort
from (values
  ('Prytanis (President)', 10), ('Epiprytanis (Vice President)', 20), ('Grammateus (Secretary)', 30),
  ('Crysophylos (Treasurer)', 40), ('Histor (Historian)', 50), ('Hypophetes (Chaplain)', 60),
  ('Pylortes (Sergeant-at-arms)', 70), ('Hegemon (Educator)', 80), ('Rush Chairman', 90),
  ('Philanthropy Chairman', 100), ('Social Chair', 110), ('Social Media Chair', 120), ('Webmaster', 130)
) as v (name, sort)
where not exists (select 1 from public.teams);
