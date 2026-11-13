#!/usr/bin/env node
// Prove the key in the page can read but not write.
//
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=... node check-rls.mjs
//
// Use the anon/publishable key here, never the service-role key.

const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_ANON_KEY || '';
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY (the same values as CONFIG in Dashboard/index.html).');
  process.exit(2);
}
if (/^sb_secret_/.test(key) || (() => { try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'service_role'; } catch { return false; } })()) {
  console.error('That is the service-role key. Use the anon key; the service-role key belongs only in GitHub Actions secrets.');
  process.exit(2);
}

const headers = { apikey: key, 'content-type': 'application/json', prefer: 'return=minimal' };
if (!/^sb_/.test(key)) headers.authorization = `Bearer ${key}`;
const rest = (path, init = {}) => fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });

const probe = '__rls_check__';
const writes = {
  kras: { id: probe, section: 'kra', name: probe, kind: 'number' },
  events: { id: probe, title: probe, starts_at: new Date().toISOString(), ends_at: new Date().toISOString() },
  sync_runs: { ok: true, message: probe },
  kra_snapshots: { day: '2000-01-01', kra_id: probe },
  rankings: { id: probe, national_rank: 1 },
};

let failed = false;
const report = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };

for (const table of Object.keys(writes)) {
  const read = await rest(`${table}?select=*&limit=1`);
  report(read.ok, `${table}: read -> HTTP ${read.status}${read.ok ? '' : ' (run supabase/schema.sql?)'}`);

  const ins = await rest(table, { method: 'POST', body: JSON.stringify(writes[table]) });
  report(!ins.ok, `${table}: insert refused -> HTTP ${ins.status}${ins.ok ? `  ** the anon key could write; delete the "${probe}" row and fix RLS **` : ''}`);

  const upd = await rest(`${table}?${table === 'sync_runs' ? 'message' : table === 'kra_snapshots' ? 'kra_id' : 'id'}=eq.${probe}`, { method: 'PATCH', body: JSON.stringify(table === 'sync_runs' ? { ok: false } : table === 'kra_snapshots' ? { points: 1 } : { [table === 'kras' ? 'name' : 'title']: 'x' }) });
  report(!upd.ok, `${table}: update refused -> HTTP ${upd.status}`);

  const del = await rest(`${table}?${table === 'kra_snapshots' ? 'kra_id' : table === 'sync_runs' ? 'message' : 'id'}=eq.${probe}`, { method: 'DELETE' });
  report(!del.ok, `${table}: delete refused -> HTTP ${del.status}`);
}

console.log(failed ? '\nThe anon key is NOT read-only. Fix before publishing the page.' : '\nThe anon key can read and cannot write. Safe to put in the page.');
process.exitCode = failed ? 1 : 0;
