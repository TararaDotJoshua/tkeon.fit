#!/usr/bin/env node
// Hourly sync for tkeon.fit/Dashboard: Google Calendar + TKE KRA page + TKE's
// public chapter rankings -> Supabase.
//
//   node sync.mjs                    full run (GitHub Actions)
//   node sync.mjs --dry-run          parse and print, write nothing
//   node sync.mjs --only=calendar    or --only=tke, --only=rankings, --only=retention
//   node sync.mjs --ics=file.ics     read a local calendar instead of GCAL_ICS_URL
//   node sync.mjs --tke-html=f.html  parse a saved KRA page instead of logging in
//   node sync.mjs --rankings-html=f  parse a saved rankings page instead of fetching it
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GCAL_ICS_URL, TKE_USERNAME, TKE_PASSWORD

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { calendarRows, fetchIcs } from './lib/calendar.mjs';
import { parseKraTables } from './lib/kra.mjs';
import { scrapeTke, scrapeFile, scrubSession, StopError } from './lib/tke.mjs';
import { parseRankings, fetchRankingsHtml, RANKINGS_URL } from './lib/rankings.mjs';
import { pnmRetention } from './lib/retention.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAPTER_TZ = 'America/New_York';
const DAY_MS = 864e5;
const KEEP_RUNS_DAYS = 90;

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    only: { type: 'string' },
    ics: { type: 'string' },
    'tke-html': { type: 'string' },
    'rankings-html': { type: 'string' },
  },
});
const env = process.env;
const dryRun = args['dry-run'];
const doCalendar = !args.only || args.only === 'calendar';
const doTke = !args.only || args.only === 'tke';
const doRankings = !args.only || args.only === 'rankings';
const doRetention = !args.only || args.only === 'retention';

// Never let a secret reach the database or the log, even inside an error message.
const SECRETS = [env.SUPABASE_SERVICE_ROLE_KEY, env.GCAL_ICS_URL, env.TKE_USERNAME, env.TKE_PASSWORD].filter((s) => s && s.length >= 4);
// scrubSession: TKE's session id lives in its URLs, and Playwright errors quote URLs.
const redact = (s) => scrubSession(SECRETS.reduce((out, secret) => out.split(secret).join('[redacted]'), String(s)));
const log = (...a) => console.log(redact(a.join(' ')));

const chapterDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: CHAPTER_TZ }).format(d);

function db() {
  if (dryRun) return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set (use --dry-run to test without a database).');
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

// --- Calendar --------------------------------------------------------------

async function syncCalendar(sb) {
  let ics;
  if (args.ics) ics = await readFile(args.ics, 'utf8');
  else if (env.GCAL_ICS_URL) ics = await fetchIcs(env.GCAL_ICS_URL);
  else {
    // Not set up yet: skip instead of failing every hour while setup is half done.
    log('Calendar: skipped, GCAL_ICS_URL is not set.');
    return 'calendar not set up yet';
  }

  // Keep a little history and two weeks ahead; the page shows today + 6 days in
  // the viewer's own time zone, so the extra day each side covers every offset.
  const now = Date.now();
  const window = { from: new Date(now - 2 * DAY_MS), to: new Date(now + 15 * DAY_MS) };
  const { rows, skipped } = calendarRows(ics, window);
  log(`Calendar: ${rows.length} events in window (${skipped.cancelled} cancelled, ${skipped.private} private skipped)`);
  if (dryRun) {
    for (const r of rows) log(`  ${r.all_day ? r.starts_at.slice(0, 10) + ' all day' : r.starts_at}  ${r.title}${r.location ? ' @ ' + r.location : ''}`);
    return `${rows.length} events`;
  }

  if (rows.length) must(await sb.from('events').upsert(rows, { onConflict: 'id' }), 'saving events');
  const existing = must(await sb.from('events').select('id'), 'reading events');
  const keep = new Set(rows.map((r) => r.id));
  const stale = existing.map((r) => r.id).filter((id) => !keep.has(id));
  for (let i = 0; i < stale.length; i += 100) {
    must(await sb.from('events').delete().in('id', stale.slice(i, i + 100)), 'removing old events');
  }
  return `${rows.length} events`;
}

// --- TKE KRAs --------------------------------------------------------------

async function syncTke(sb) {
  const config = JSON.parse(await readFile(path.join(HERE, 'tke.config.json'), 'utf8'));
  // Both URLs still FILL_ME means the TKE step isn't set up yet: skip it. Half
  // filled in (one URL, or URLs without the login secrets) still fails loudly.
  const unset = (u) => !u || /FILL_ME/.test(u);
  if (!args['tke-html'] && unset(config.loginUrl) && unset(config.kraUrl)) {
    log('TKE: skipped, loginUrl and kraUrl in tke.config.json are not filled in.');
    return 'TKE not set up yet';
  }
  const raw = args['tke-html']
    ? await scrapeFile(args['tke-html'])
    : await scrapeTke({ config, username: env.TKE_USERNAME, password: env.TKE_PASSWORD, debugDir: path.join(HERE, 'debug'), log });

  const { rows, totals, warnings } = parseKraTables(raw);
  const t = (s) => `${totals[s].points}/${totals[s].out_of}`;
  const summary = `KRAs ${t('kra')} (${totals.kra.met} of ${totals.kra.count} met), required ${t('required')}, bonus ${t('bonus')}`;
  log(`TKE: ${rows.length} rows. ${summary}`);
  for (const w of warnings) log(`TKE warning: ${w}`);

  if (!rows.length) throw new Error('Found the KRA page but no rows in it. Check the table detection.');
  const missing = ['kra', 'required', 'bonus'].filter((s) => !totals[s].count);
  if (missing.length) warnings.push(`no rows for ${missing.join(', ')}`);
  const mismatch = warnings.filter((w) => w.includes("don't match"));
  if (mismatch.length) throw new Error(mismatch.join('; '));

  if (dryRun) {
    for (const r of rows) log(`  ${r.section.padEnd(8)} ${r.name.padEnd(36)} ${String(r.result_text).padEnd(12)} goal ${String(r.goal_text).padEnd(12)} ${r.points}/${r.out_of} ${r.met ? 'met' : r.met === false ? 'not met' : '?'}`);
    return summary;
  }

  // Refuse to wipe the table on a half-loaded page.
  const existing = must(await sb.from('kras').select('id'), 'reading kras');
  if (existing.length >= 4 && rows.length < existing.length / 2) {
    throw new Error(`Only found ${rows.length} rows but the database has ${existing.length}; not deleting anything. Check the KRA page.`);
  }

  // term_start, due_date and note are left out on purpose so hand edits survive.
  const now = new Date().toISOString();
  must(await sb.from('kras').upsert(rows.map((r) => ({ ...r, updated_at: now })), { onConflict: 'id' }), 'saving kras');
  const keep = new Set(rows.map((r) => r.id));
  const gone = existing.map((r) => r.id).filter((id) => !keep.has(id));
  if (gone.length) {
    must(await sb.from('kras').delete().in('id', gone), 'removing dropped kras');
    log(`TKE: removed ${gone.length} row(s) nationals no longer lists: ${gone.join(', ')}`);
  }

  // One snapshot per KRA per chapter day; later runs that day overwrite it.
  const day = chapterDay();
  must(await sb.from('kra_snapshots').upsert(rows.map((r) => ({ day, kra_id: r.id, current: r.current, points: r.points })), { onConflict: 'day,kra_id' }), 'saving snapshots');

  return summary + (warnings.length ? ` (warning: ${warnings.join('; ')})` : '');
}

// --- Rankings ----------------------------------------------------------------

async function syncRankings(sb) {
  const config = JSON.parse(await readFile(path.join(HERE, 'tke.config.json'), 'utf8'));
  if (!config.chapterName) return 'rankings not set up yet';
  const html = args['rankings-html'] ? await readFile(args['rankings-html'], 'utf8') : await fetchRankingsHtml(config.rankingsUrl || RANKINGS_URL);
  const r = parseRankings(html, config.chapterName);
  const summary = `rank ${r.national_rank} of ${r.national_total} nationally, ${r.region_rank} of ${r.region_total} in region ${r.region}`;
  log(`Rankings: ${summary} (score ${r.score_text}, since yesterday ${r.since_yesterday}, since last week ${r.since_week})`);
  if (dryRun) return summary;
  must(await sb.from('rankings').upsert({ id: 'kra', ...r, updated_at: new Date().toISOString() }, { onConflict: 'id' }), 'saving rankings');
  return summary;
}

// --- Run -------------------------------------------------------------------

async function main() {
  const sb = db();
  const done = [];
  const problems = [];
  let stopped = false;

  if (doCalendar) {
    try { done.push(await syncCalendar(sb)); } catch (e) { problems.push(`Calendar: ${e.message}`); }
  }
  if (doTke) {
    try { done.push(await syncTke(sb)); } catch (e) {
      stopped = e instanceof StopError;
      problems.push(`TKE: ${e.message}`);
    }
  }

  // Rankings are an extra: if tke.org changes that page, say so in the log and
  // the run message, but don't flag the whole sync (and the TV) as failed. The
  // page shows the date of the rankings it has once they are over a day old.
  if (doRankings) {
    try { done.push(await syncRankings(sb)); } catch (e) {
      done.push(`rankings not updated (${e.message})`);
      console.log(`::warning::Rankings not updated: ${redact(e.message)}`);
    }
  }

  // Recruitment: delete PNM records (and their photos) a year after they were entered.
  if (doRetention && sb) {
    try { done.push(await pnmRetention(sb)); } catch (e) {
      done.push(`PNM clean-up didn't finish (${e.message})`);
      console.log(`::warning::PNM clean-up didn't finish: ${redact(e.message)}`);
    }
  }

  const ok = problems.length === 0;
  const message = redact([...problems, ...done].join(' | ')).slice(0, 500);
  log(ok ? `OK: ${message}` : `FAILED: ${message}`);
  if (stopped) log('Stopped at a site protection. Tell the dashboard owner; do not work around it.');

  if (sb) {
    must(await sb.from('sync_runs').insert({ ok, message }), 'recording sync run');
    const cutoff = new Date(Date.now() - KEEP_RUNS_DAYS * DAY_MS).toISOString();
    await sb.from('sync_runs').delete().lt('ran_at', cutoff);
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(redact(e?.stack || e));
  process.exitCode = 1;
});
