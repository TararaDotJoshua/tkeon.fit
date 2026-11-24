-- The chapter advisor's sign-in. Run after app.sql. Safe to run again.
--
-- An advisor has no scroll number, so instead:
--  1. An admin makes a one-time invite code in Settings > Members and gives it
--     to the advisor (it's shown once; only a hash of it is kept).
--  2. The advisor signs up with any email, that code, and a password of their
--     own. The code is used up, and expires after 7 days if it isn't.
--  3. The account is an admin, marked as the advisor (profiles.is_advisor), so
--     the app doesn't count or offer it as a brother.
-- The sign-up itself is checked in app.sql's sign-up triggers.

create table if not exists private.advisor_invites (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null unique,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by    uuid references auth.users (id) on delete set null,
  used_at    timestamptz
);

-- Codes are compared without dashes, spaces or case.
create or replace function private.advisor_code_hash(p_code text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex');
$$;

-- A new invite code, like K7QM-3TXA-9PRW: 12 characters that can't be misread
-- (no 0/O, 1/I/L, 2/Z, 5/S, 8/B). Shown to the admin once.
create or replace function public.admin_create_advisor_invite() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  abc   constant text := 'ACDEFGHJKMNPQRTUVWXY3469';
  bytes bytea := extensions.gen_random_bytes(12);
  code  text := '';
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  for i in 0..11 loop
    code := code || substr(abc, 1 + get_byte(bytes, i) % length(abc), 1);
  end loop;
  insert into private.advisor_invites (code_hash, created_by) values (private.advisor_code_hash(code), (select auth.uid()));
  return substr(code, 1, 4) || '-' || substr(code, 5, 4) || '-' || substr(code, 9, 4);
end;
$$;

-- Invites nobody has used yet (never the codes themselves).
create or replace function public.admin_advisor_invites()
returns table (id uuid, created_at timestamptz, expires_at timestamptz, created_by_name text)
language sql stable security definer set search_path = '' as $$
  select i.id, i.created_at, i.expires_at, p.name
  from private.advisor_invites i left join public.profiles p on p.id = i.created_by
  where public.is_admin() and i.used_at is null and i.expires_at > now()
  order by i.created_at desc;
$$;

create or replace function public.admin_cancel_advisor_invite(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  delete from private.advisor_invites where id = p_id and used_at is null;
end;
$$;

-- What the advisor sign-in form should do: 'bad_email', 'has_account' (sign in
-- with the password instead), 'bad_code' (wrong, used or expired) or 'ok'.
create or replace function public.advisor_invite_state(p_email text, p_code text) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_email is null or p_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return 'bad_email';
  end if;
  if exists (select 1 from auth.users u where lower(u.email) = lower(p_email)) then
    return 'has_account';
  end if;
  if not exists (select 1 from private.advisor_invites i
                 where i.code_hash = private.advisor_code_hash(p_code) and i.used_at is null and i.expires_at > now()) then
    return 'bad_code';
  end if;
  return 'ok';
end;
$$;

-- Supabase grants new functions to anon and authenticated directly.
revoke execute on function public.admin_create_advisor_invite(), public.admin_advisor_invites(),
  public.admin_cancel_advisor_invite(uuid), public.advisor_invite_state(text, text) from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function public.admin_create_advisor_invite(), public.admin_advisor_invites(),
  public.admin_cancel_advisor_invite(uuid) to authenticated;
grant execute on function public.advisor_invite_state(text, text) to anon, authenticated;
