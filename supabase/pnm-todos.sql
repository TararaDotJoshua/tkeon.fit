-- PNM to-dos: a checklist of steps for each PNM ("Invite to the cookout",
-- "Get him to bid night"), in place of the single "Next step".
-- Run after recruit.sql. Safe to run again.
--
--  - Recruiters (and admins) read and write them, like the PNMs themselves.
--  - A step can be given to any brother with recruiting access, and can have
--    a due date. Ticking it off records who and when, and adds a line to the
--    PNM's history.
--  - They're deleted with the PNM (so with the one-year cleanup, too).

create table if not exists public.pnm_todos (
  id         uuid primary key default gen_random_uuid(),
  pnm_id     uuid not null references public.pnms (id) on delete cascade,
  title      text not null check (char_length(btrim(title)) between 1 and 200),
  due        date,
  assignee   uuid references public.profiles (id) on delete set null,
  done       boolean not null default false,
  done_at    timestamptz,
  done_by    uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists pnm_todos_pnm on public.pnm_todos (pnm_id);
create index if not exists pnm_todos_assignee on public.pnm_todos (assignee) where not done;

-- Ticking a step off goes in the PNM's history.
alter table public.pnm_log drop constraint if exists pnm_log_kind_check;
alter table public.pnm_log add constraint pnm_log_kind_check
  check (kind in ('created', 'contact', 'note', 'stage', 'assigned', 'todo'));

-- ---------------------------------------------------------------------------
-- Bookkeeping: who made it, who ticked it and when. Nobody can set those, or
-- move a step to another PNM, or give it to someone without recruiting access.
-- ---------------------------------------------------------------------------
create or replace function private.pnm_todo_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
    new.created_at := now();
  else
    new.pnm_id := old.pnm_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.title := btrim(new.title);
  if new.done and (tg_op = 'INSERT' or not old.done) then
    new.done_at := now(); new.done_by := (select auth.uid());
  elsif not new.done then
    new.done_at := null; new.done_by := null;
  else
    new.done_at := old.done_at; new.done_by := old.done_by;
  end if;
  if new.assignee is not null and (tg_op = 'INSERT' or new.assignee is distinct from old.assignee)
     and not exists (select 1 from public.profiles p where p.id = new.assignee and not p.disabled and (p.can_recruit or p.is_admin)) then
    raise exception 'assignee_not_recruiter';
  end if;
  return new;
end;
$$;
drop trigger if exists pnm_todo_before_write on public.pnm_todos;
create trigger pnm_todo_before_write before insert or update on public.pnm_todos
  for each row execute function private.pnm_todo_before_write();

create or replace function private.pnm_todo_after_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.done and (tg_op = 'INSERT' or not old.done) then
    insert into public.pnm_log (pnm_id, kind, note) values (new.pnm_id, 'todo', left(new.title, 1000));
  end if;
  return new;
end;
$$;
drop trigger if exists pnm_todo_after_write on public.pnm_todos;
create trigger pnm_todo_after_write after insert or update on public.pnm_todos
  for each row execute function private.pnm_todo_after_write();

-- ---------------------------------------------------------------------------
-- Access: recruiters only, the same as the PNMs.
-- ---------------------------------------------------------------------------
alter table public.pnm_todos enable row level security;
revoke all on public.pnm_todos from anon, authenticated;
grant select, delete on public.pnm_todos to authenticated;
grant insert (pnm_id, title, due, assignee, done) on public.pnm_todos to authenticated;
grant update (title, due, assignee, done) on public.pnm_todos to authenticated;
grant select, insert, update, delete on public.pnm_todos to service_role;

drop policy if exists "recruiters" on public.pnm_todos;
create policy "recruiters" on public.pnm_todos for all to authenticated
  using ((select public.is_recruiter())) with check ((select public.is_recruiter()));

revoke execute on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Each PNM's old "Next step" becomes his first to-do (once).
-- ---------------------------------------------------------------------------
insert into public.pnm_todos (pnm_id, title, due)
select p.id, left(btrim(p.next_step), 200), p.next_date
from public.pnms p
where nullif(btrim(p.next_step), '') is not null;
update public.pnms set next_step = null, next_date = null where next_step is not null or next_date is not null;
