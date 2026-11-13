-- Recruitment: PNMs, the contact log, the public interest form, and deletion
-- one year after a PNM is entered. Run after schema.sql and app.sql, in the
-- Supabase SQL editor. It is safe to run again.
--
-- Who can do what:
--   anyone (not signed in)  submits the interest form through one function, and
--                           uploads that submission's photo once. Reads nothing.
--   signed-in member        nothing here until an admin turns on his recruitment access.
--   recruiter               reads and changes PNMs, their log and their photos.
--   admin                   always a recruiter; turns recruitment access on and off.
--
-- Nothing in this file is readable by the public. PNM changes are logged in
-- pnm_log (recruiters only), never in the public activity table.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Who has access
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists can_recruit boolean not null default false;

create or replace function public.is_recruiter() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and not p.disabled and (p.can_recruit or p.is_admin)
  );
$$;

create or replace function public.admin_set_recruiter(p_id uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'admins only';
  end if;
  update public.profiles set can_recruit = p_on where id = p_id;
end;
$$;

-- "Spring 2027" for January to May, "Fall 2026" for June to December.
create or replace function private.term_for(d date) returns text
language sql immutable set search_path = '' as $$
  select case when extract(month from d) <= 5 then 'Spring ' else 'Fall ' end || extract(year from d)::int::text;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.pnms (
  id              uuid primary key default gen_random_uuid(),
  term            text not null check (term ~ '^(Spring|Fall) [0-9]{4}$'),
  stage           text not null default 'interested'
                  check (stage in ('interested', 'contacted', 'met', 'invited', 'bid', 'accepted', 'deferred', 'declined')),
  -- From the interest form
  name            text not null check (char_length(name) between 1 and 120),
  phone           text check (char_length(phone) <= 30),
  email           text check (char_length(email) <= 200),
  contact_pref    text check (contact_pref in ('phone', 'email')),
  student_id      text check (student_id ~ '^[0-9]{9}$'),           -- the 900 number
  major           text check (char_length(major) <= 120),
  hobbies         text check (char_length(hobbies) <= 2000),
  social          text check (char_length(social) <= 120),
  allergies       text check (char_length(allergies) <= 300),
  met_by_text     text check (char_length(met_by_text) <= 120),     -- "Which brother did you speak with?"
  photo_path      text check (char_length(photo_path) <= 200),       -- in the private pnm-photos bucket
  source          text not null default 'added' check (source in ('form', 'added')),
  -- Recruitment
  main_contact    uuid references public.profiles (id) on delete set null,
  next_step       text check (char_length(next_step) <= 300),
  next_date       date,
  last_contact_at timestamptz,
  created_by      uuid references public.profiles (id) on delete set null,
  updated_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists pnms_term_idx on public.pnms (term, stage);
create index if not exists pnms_created_idx on public.pnms (created_at);

-- Contacts, notes, stage changes and assignments, newest last.
create table if not exists public.pnm_log (
  id      bigint generated always as identity primary key,
  pnm_id  uuid not null references public.pnms (id) on delete cascade,
  actor   uuid references public.profiles (id) on delete set null,
  at      timestamptz not null default now(),
  kind    text not null check (kind in ('created', 'contact', 'note', 'stage', 'assigned')),
  how     text check (how in ('text', 'call', 'in_person', 'event', 'social', 'other')),
  note    text check (char_length(note) <= 1000)
);
create index if not exists pnm_log_pnm_idx on public.pnm_log (pnm_id, at);

-- ---------------------------------------------------------------------------
-- Bookkeeping triggers
-- ---------------------------------------------------------------------------
create or replace function private.pnm_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then
    return new; -- the database's own bookkeeping, not a recruiter's edit
  end if;
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
    new.created_at := now();
    new.term := coalesce(new.term, private.term_for((now() at time zone 'America/New_York')::date));
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at; -- the one-year clock can't be reset by an edit
    new.source := old.source;
  end if;
  new.email := lower(new.email);
  new.updated_by := (select auth.uid());
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists pnm_before_write on public.pnms;
create trigger pnm_before_write before insert or update on public.pnms
  for each row execute function private.pnm_before_write();

create or replace function private.pnm_after_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  label jsonb := '{"interested":"Interested","contacted":"Contacted","met":"Met","invited":"Invited","bid":"Bid","accepted":"Accepted","deferred":"Deferred","declined":"Did not accept"}';
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_op = 'INSERT' then
    insert into public.pnm_log (pnm_id, actor, kind, note)
    values (new.id, (select auth.uid()), 'created', case new.source when 'form' then 'Sent the interest form' else 'Added' end);
    return new;
  end if;
  if new.stage is distinct from old.stage then
    insert into public.pnm_log (pnm_id, actor, kind, note)
    values (new.id, (select auth.uid()), 'stage', (label ->> old.stage) || ' → ' || (label ->> new.stage));
  end if;
  if new.main_contact is distinct from old.main_contact then
    insert into public.pnm_log (pnm_id, actor, kind, note)
    values (new.id, (select auth.uid()), 'assigned', coalesce((select p.name from public.profiles p where p.id = new.main_contact), 'Nobody'));
  end if;
  return new;
end;
$$;
drop trigger if exists pnm_after_write on public.pnms;
create trigger pnm_after_write after insert or update on public.pnms
  for each row execute function private.pnm_after_write();

create or replace function private.pnm_log_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.actor := (select auth.uid());
  new.at := now();
  return new;
end;
$$;
drop trigger if exists pnm_log_before_insert on public.pnm_log;
create trigger pnm_log_before_insert before insert on public.pnm_log
  for each row execute function private.pnm_log_before_insert();

create or replace function private.pnm_log_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'contact' then
    update public.pnms set last_contact_at = new.at where id = new.pnm_id;
  end if;
  return new;
end;
$$;
drop trigger if exists pnm_log_after_insert on public.pnm_log;
create trigger pnm_log_after_insert after insert on public.pnm_log
  for each row execute function private.pnm_log_after_insert();

-- ---------------------------------------------------------------------------
-- The public interest form (tkeon.fit/Interest)
-- ---------------------------------------------------------------------------
-- The only way the public can write anything here. It adds one new PNM to the
-- current semester and returns where to upload his photo. It can't read or
-- change anything else.
create or replace function public.submit_interest(
  p_name text, p_phone text, p_email text, p_contact_pref text, p_student_id text,
  p_major text, p_hobbies text, p_allergies text, p_met_by text,
  p_social text default null, p_photo boolean default false, p_website text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id     uuid := gen_random_uuid();
  v_token  text := encode(extensions.gen_random_bytes(12), 'hex');
  v_phone  text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_email  text := lower(trim(coalesce(p_email, '')));
  v_sid    text := regexp_replace(coalesce(p_student_id, ''), '[^0-9]', '', 'g');
  v_met    text := trim(coalesce(p_met_by, ''));
  v_main   uuid;
  v_path   text;
begin
  -- A filled-in hidden field means a bot. Say thanks and store nothing.
  if coalesce(trim(p_website), '') <> '' then
    return jsonb_build_object('ok', true);
  end if;
  if (select count(*) from public.pnms where source = 'form' and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'busy';
  end if;
  if char_length(trim(coalesce(p_name, ''))) not between 2 and 120 then raise exception 'bad_name'; end if;
  if char_length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 10 and 15 then raise exception 'bad_phone'; end if;
  if not private.fit_email(v_email) then raise exception 'bad_email'; end if;
  if p_contact_pref not in ('phone', 'email') then raise exception 'bad_contact_pref'; end if;
  if v_sid !~ '^900[0-9]{6}$' then raise exception 'bad_student_id'; end if;
  if char_length(trim(coalesce(p_major, ''))) not between 1 and 120 then raise exception 'bad_major'; end if;
  if char_length(trim(coalesce(p_hobbies, ''))) not between 1 and 2000 then raise exception 'bad_hobbies'; end if;
  if char_length(trim(coalesce(p_allergies, ''))) not between 1 and 300 then raise exception 'bad_allergies'; end if;
  if char_length(v_met) not between 1 and 120 then raise exception 'bad_met_by'; end if;
  if char_length(coalesce(p_social, '')) > 120 then raise exception 'bad_social'; end if;
  -- A double tap sends twice; keep the first.
  if exists (select 1 from public.pnms where email = v_email and source = 'form' and created_at > now() - interval '2 minutes') then
    raise exception 'already_sent';
  end if;

  -- "Which brother did you speak with?" becomes his main contact when it matches exactly one brother.
  if (select count(*) from public.profiles p where lower(p.name) = lower(v_met) and not p.disabled) = 1 then
    select p.id into v_main from public.profiles p where lower(p.name) = lower(v_met) and not p.disabled;
  end if;
  if p_photo then
    v_path := v_id::text || '/' || v_token || '.jpg';
  end if;

  insert into public.pnms (id, source, stage, name, phone, email, contact_pref, student_id, major, hobbies,
                           allergies, met_by_text, social, main_contact, photo_path)
  values (v_id, 'form', 'interested', trim(p_name), v_phone, v_email, p_contact_pref, v_sid, trim(p_major),
          trim(p_hobbies), trim(p_allergies), v_met, nullif(trim(coalesce(p_social, '')), ''), v_main, v_path);
  return jsonb_build_object('ok', true, 'photo_path', v_path);
end;
$$;

-- The form may upload a photo only to the exact path it was given, within 30 minutes.
create or replace function public.interest_photo_ok(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.pnms p
    where p.photo_path = p_name and p.source = 'form' and p.created_at > now() - interval '30 minutes'
  );
$$;

-- Brothers' names for the form's "Which brother did you speak with?" suggestions.
-- (Names are already public on the dashboard.)

-- ---------------------------------------------------------------------------
-- Deleting PNM records one year after they were entered
-- ---------------------------------------------------------------------------
create or replace function public.purge_old_pnms() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.pnms where created_at < now() - interval '1 year';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Runs daily. The hourly sync also runs it, and deletes the photos of PNMs that are gone.
create extension if not exists pg_cron;
select cron.schedule('pnm-retention', '17 9 * * *', $cron$ select public.purge_old_pnms(); $cron$);

-- ---------------------------------------------------------------------------
-- Access rules
-- ---------------------------------------------------------------------------
alter table public.pnms    enable row level security;
alter table public.pnm_log enable row level security;
revoke all on public.pnms, public.pnm_log from anon, authenticated;
grant select, insert, update, delete on public.pnms to authenticated;
grant select, insert, delete on public.pnm_log to authenticated;
grant select, insert, update, delete on public.pnms, public.pnm_log to service_role;

drop policy if exists "recruiters" on public.pnms;
create policy "recruiters" on public.pnms for all to authenticated
  using (public.is_recruiter()) with check (public.is_recruiter());

drop policy if exists "recruiters read" on public.pnm_log;
drop policy if exists "recruiters write" on public.pnm_log;
drop policy if exists "recruiters remove own" on public.pnm_log;
create policy "recruiters read" on public.pnm_log for select to authenticated using (public.is_recruiter());
create policy "recruiters write" on public.pnm_log for insert to authenticated
  with check (public.is_recruiter() and kind in ('contact', 'note'));
create policy "recruiters remove own" on public.pnm_log for delete to authenticated
  using (public.is_recruiter() and actor = (select auth.uid()) and kind in ('contact', 'note'));

-- Supabase grants new functions to anon and authenticated directly, so revoking
-- from "public" alone isn't enough.
revoke execute on function public.is_recruiter(), public.admin_set_recruiter(uuid, boolean),
  public.submit_interest(text, text, text, text, text, text, text, text, text, text, boolean, text),
  public.interest_photo_ok(text), public.purge_old_pnms() from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function public.is_recruiter() to anon, authenticated;
grant execute on function public.admin_set_recruiter(uuid, boolean) to authenticated;
grant execute on function public.submit_interest(text, text, text, text, text, text, text, text, text, text, boolean, text) to anon, authenticated;
grant execute on function public.interest_photo_ok(text) to anon, authenticated;
grant execute on function public.purge_old_pnms() to service_role;

-- ---------------------------------------------------------------------------
-- PNM photos: a private bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pnm-photos', 'pnm-photos', false, 2097152, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "pnm photos: form upload" on storage.objects;
drop policy if exists "pnm photos: recruiters read" on storage.objects;
drop policy if exists "pnm photos: recruiters add" on storage.objects;
drop policy if exists "pnm photos: recruiters replace" on storage.objects;
drop policy if exists "pnm photos: recruiters remove" on storage.objects;
create policy "pnm photos: form upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'pnm-photos' and public.interest_photo_ok(name));
create policy "pnm photos: recruiters read" on storage.objects for select to authenticated
  using (bucket_id = 'pnm-photos' and public.is_recruiter());
create policy "pnm photos: recruiters add" on storage.objects for insert to authenticated
  with check (bucket_id = 'pnm-photos' and public.is_recruiter());
create policy "pnm photos: recruiters replace" on storage.objects for update to authenticated
  using (bucket_id = 'pnm-photos' and public.is_recruiter());
create policy "pnm photos: recruiters remove" on storage.objects for delete to authenticated
  using (bucket_id = 'pnm-photos' and public.is_recruiter());
