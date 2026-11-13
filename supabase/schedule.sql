-- Hourly trigger for the dashboard sync.
-- Run once in the Supabase SQL editor. It is safe to run again.
--
-- GitHub's own cron is best-effort and was firing every 6 to 9 hours on this
-- repo. Starting the workflow through GitHub's API is reliable, so this
-- database starts it at minute 7 of every hour. The workflow's own schedule
-- stays on as a slower backup.
--
-- Needs one secret in Supabase Vault (Integrations -> Vault -> Add new secret):
--   name   github_dispatch_token
--   value  a fine-grained GitHub token limited to the tkeon.fit repo with
--          "Actions: Read and write" and nothing else
-- The token never goes in this file, the repo or the page.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'dashboard-sync-hourly',
  '7 * * * *',
  $cron$
  do $job$
  declare
    token text;
  begin
    select decrypted_secret into token
    from vault.decrypted_secrets
    where name = 'github_dispatch_token';
    if token is null then
      raise exception 'Vault secret github_dispatch_token is missing; the dashboard sync was not started.';
    end if;
    perform net.http_post(
      url := 'https://api.github.com/repos/TararaDotJoshua/tkeon.fit/actions/workflows/dashboard-sync.yml/dispatches',
      body := '{"ref":"main"}'::jsonb,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Accept', 'application/vnd.github+json',
        'X-GitHub-Api-Version', '2022-11-28',
        'User-Agent', 'tkeon-dashboard',
        'Content-Type', 'application/json'
      ),
      timeout_milliseconds := 10000
    );
  end
  $job$;
  $cron$
);

-- Keep a week of job history so the log doesn't grow forever.
select cron.schedule(
  'dashboard-sync-log-cleanup',
  '23 4 * * *',
  $cron$
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  $cron$
);

-- To check it's working:
--   select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
--   select status_code, created from net._http_response order by created desc limit 5;  -- 204 = GitHub accepted it
-- To stop it:
--   select cron.unschedule('dashboard-sync-hourly');
