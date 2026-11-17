#!/usr/bin/env node
// Budget sync for the Finances screen: the Treasurer's Google Sheet -> Supabase.
// Runs every few minutes (supabase/schedule.sql starts .github/workflows/budget-sync.yml).
//
//   node budget.mjs              read the Sheet and replace public.budget_lines
//   node budget.mjs --dry-run    read and parse, write nothing
//   node budget.mjs --csv=f.csv  read a local CSV export of the tab instead of the Sheet
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      BUDGET_SHEET_URL             a link to the budget tab (with its #gid=)
//      GOOGLE_SERVICE_ACCOUNT_JSON  the robot's key; the Sheet is shared with its email as a Viewer
//
// The repo and its Actions logs are public, so this never prints the link, the
// key or any amount: only how many lines it read.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { parseBudget } from './lib/budget.mjs';
import { sheetRows } from './lib/google.mjs';

const { values: args } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, csv: { type: 'string' } } });
const env = process.env;

async function main() {
  const db = args['dry-run'] ? null : createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const now = new Date().toISOString();
  let lines;
  try {
    if (!args.csv && (!env.BUDGET_SHEET_URL || !env.GOOGLE_SERVICE_ACCOUNT_JSON)) throw new Error('BUDGET_SHEET_URL or GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
    lines = parseBudget(args.csv ? await readFile(args.csv, 'utf8') : await sheetRows(env.BUDGET_SHEET_URL, env.GOOGLE_SERVICE_ACCOUNT_JSON));
  } catch (e) {
    // Keep the last good budget on screen; record why this read failed.
    console.error(`Budget not updated: ${e.message}`);
    if (db) await db.from('budget_sync').upsert({ id: true, tried_at: now, problem: String(e.message).slice(0, 300) });
    process.exitCode = 1;
    return;
  }
  if (!db) { console.log(`Read ${lines.length} budget lines (dry run, nothing written).`); return; }

  const up = await db.from('budget_lines').upsert(lines, { onConflict: 'name' });
  if (up.error) throw up.error;
  // Lines no longer in the Sheet go away.
  const { data: have, error } = await db.from('budget_lines').select('name');
  if (error) throw error;
  const keep = new Set(lines.map((l) => l.name));
  const gone = (have || []).map((r) => r.name).filter((n) => !keep.has(n));
  if (gone.length) { const del = await db.from('budget_lines').delete().in('name', gone); if (del.error) throw del.error; }
  const st = await db.from('budget_sync').upsert({ id: true, synced_at: now, tried_at: now, problem: null });
  if (st.error) throw st.error;
  console.log(`Budget updated: ${lines.length} lines${gone.length ? `, ${gone.length} removed` : ''}.`);
}

main().catch((e) => { console.error(`Budget sync failed: ${e.message}`); process.exitCode = 1; });
