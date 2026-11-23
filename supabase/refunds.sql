-- Refund requests: a brother asks to be paid back for something he bought for
-- the chapter. Run after app.sql (it uses profiles, teams and is_member()).
-- Safe to run again.
--
--  - Any signed-in brother files one: a receipt photo, the amount, what it was
--    for, optionally the committee, and how to pay him back. He sees only his own.
--  - Whoever holds the Prytanis or Crysophylos position sees everyone's and moves
--    them through Submitted -> In review -> Processed. Nobody else does, admins
--    included: receipts can show card digits and addresses.
--  - Requests and receipts are kept; nothing deletes them automatically. A brother
--    can withdraw his own while it's still Submitted.

-- ---------------------------------------------------------------------------
-- Who reviews: the active Prytanis and Crysophylos (either spelling).
-- ---------------------------------------------------------------------------
create or replace function public.is_refund_reviewer() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_member() and exists (
    select 1 from public.profile_teams pt
    join public.teams t on t.id = pt.team_id
    where pt.profile_id = (select auth.uid())
      and t.kind = 'position' and t.archived_at is null
      and t.name ~* '^(prytanis|crysophylos|chrysophylos)\M'
  );
$$;

-- ---------------------------------------------------------------------------
-- The requests.
-- ---------------------------------------------------------------------------
create table if not exists public.refund_requests (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid default auth.uid() references public.profiles (id) on delete set null, -- kept if the account goes
  amount       numeric(10, 2) not null check (amount > 0 and amount <= 10000),
  what_for     text not null check (char_length(btrim(what_for)) between 1 and 300),
  committee_id uuid references public.teams (id) on delete set null,
  pay_to       text not null check (char_length(btrim(pay_to)) between 1 and 120),
  receipt_path text not null check (char_length(receipt_path) <= 200),
  status       text not null default 'submitted' check (status in ('submitted', 'in_review', 'processed')),
  status_by    uuid references public.profiles (id) on delete set null,
  status_at    timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists refund_requests_profile on public.refund_requests (profile_id);
create index if not exists refund_requests_status on public.refund_requests (status, created_at desc);

alter table public.refund_requests enable row level security;

drop policy if exists "refunds: own or reviewer reads" on public.refund_requests;
create policy "refunds: own or reviewer reads" on public.refund_requests
  for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_refund_reviewer()));

-- A brother files his own, starting at Submitted, with a receipt in his own
-- folder and, if any, a committee that exists.
drop policy if exists "refunds: brother files his own" on public.refund_requests;
create policy "refunds: brother files his own" on public.refund_requests
  for insert to authenticated
  with check (
    (select public.is_member())
    and profile_id = (select auth.uid())
    and status = 'submitted' and status_by is null and status_at is null
    and receipt_path like (select auth.uid())::text || '/%'
    and (committee_id is null or exists (
      select 1 from public.teams t where t.id = committee_id and t.kind = 'committee' and t.archived_at is null))
  );

-- He can withdraw it only while nobody has picked it up.
drop policy if exists "refunds: brother withdraws while submitted" on public.refund_requests;
create policy "refunds: brother withdraws while submitted" on public.refund_requests
  for delete to authenticated
  using (profile_id = (select auth.uid()) and status = 'submitted' and (select public.is_member()));

-- No update rule: status changes go through refund_set_status() below, and the
-- request itself (amount, receipt, who) never changes after it's filed.
revoke all on public.refund_requests from anon, authenticated;
grant select, delete on public.refund_requests to authenticated;
grant insert (amount, what_for, committee_id, pay_to, receipt_path) on public.refund_requests to authenticated;
grant select, insert, update, delete on public.refund_requests to service_role;

-- ---------------------------------------------------------------------------
-- Moving a request along: only the Prytanis or Crysophylos.
-- ---------------------------------------------------------------------------
create or replace function public.refund_set_status(p_id uuid, p_status text)
returns public.refund_requests
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.refund_requests;
begin
  if not public.is_refund_reviewer() then raise exception 'reviewers_only'; end if;
  if p_status not in ('submitted', 'in_review', 'processed') then raise exception 'bad_status'; end if;
  update public.refund_requests
     set status = p_status, status_by = (select auth.uid()), status_at = now()
   where id = p_id
  returning * into r;
  if r.id is null then raise exception 'not_found'; end if;
  return r;
end;
$$;

revoke all on function public.is_refund_reviewer() from public, anon, authenticated;
revoke all on function public.refund_set_status(uuid, text) from public, anon, authenticated;
grant execute on function public.is_refund_reviewer() to authenticated;
grant execute on function public.refund_set_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Receipt photos: a private bucket. Each brother uploads into his own folder
-- (<his id>/...); he and the reviewers can view them. Nobody can overwrite
-- one, and a brother can remove his only while its request is still Submitted
-- (or was never filed).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "receipts: brother uploads his own" on storage.objects;
drop policy if exists "receipts: own or reviewer views" on storage.objects;
drop policy if exists "receipts: brother removes an unfiled one" on storage.objects;
create policy "receipts: brother uploads his own" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (select public.is_member()) and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "receipts: own or reviewer views" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_refund_reviewer())));
create policy "receipts: brother removes an unfiled one" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text
    and not exists (select 1 from public.refund_requests r where r.receipt_path = name and r.status <> 'submitted'));
