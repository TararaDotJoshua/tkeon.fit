-- Pace markers for the cumulative KRAs (task 5).
-- Fill in the KRA year dates, then run in the Supabase SQL editor.
-- The sync never touches term_start, due_date or note, so this sticks.
-- Run it again each KRA year with the new dates.

update public.kras
set term_start = date '2026-08-01',   -- FILL_ME: first day the KRA year counts from
    due_date   = date '2027-05-01'    -- FILL_ME: day nationals totals the KRA year
where section = 'kra'
  and (   name ilike '%service%'
       or name ilike '%st. jude%'
       or name ilike '%st jude%'
       or name ilike '%philanthrop%'
       or name ilike '%initiat%');

-- Check which rows got dates:
select id, name, term_start, due_date from public.kras where section = 'kra' order by sort_order;
