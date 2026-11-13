-- Pace markers for the cumulative KRAs (task 5).
-- Run in the Supabase SQL editor after the first sync has filled the kras table.
-- The sync never touches term_start, due_date or note, so this sticks.
--
-- TKE's KRA year runs June 1 to May 31 (the award periods on my.tke.org read
-- "6/1/2025 - 5/31/2026"). Each June, run this again with the next year's dates.

update public.kras
set term_start = date '2026-06-01',
    due_date   = date '2027-05-31'
where section = 'kra'
  and (   name ilike '%service%'
       or name ilike '%st. jude%'
       or name ilike '%st jude%'
       or name ilike '%philanthrop%'
       or name ilike '%initiat%');

-- Check which rows got dates:
select id, name, term_start, due_date from public.kras where section = 'kra' order by sort_order;
