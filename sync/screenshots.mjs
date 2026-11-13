#!/usr/bin/env node
// Screenshot every dashboard screen and check the layout rules:
//   TV (?tv) at 1920x1080 (plus 1280x720 and 3840x2160): no scrolling, nothing cut off
//   Members at 390 px: no horizontal scroll
// Also drives the live code path against a mocked Supabase (healthy, failed +
// stale sync, database down) so the notices get checked too.
//
//   node screenshots.mjs            -> sync/.shots/*.png, exits 1 on any failure

import http from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { calendarRows } from './lib/calendar.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, '.shots');
const MOCK_DB = 'https://mock-db.supabase.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// Static server for the repo. /Dashboard/live.html is index.html pointed at the mock database.
function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    const live = url.pathname === '/Dashboard/live.html';
    if (live) file = path.join(ROOT, 'Dashboard/index.html');
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    try {
      let body = await readFile(file);
      if (live) body = body.toString().replace(/supabaseUrl: '[^']*'/, `supabaseUrl: '${MOCK_DB}'`).replace(/supabaseAnonKey: '[^']*'/, "supabaseAnonKey: 'mock-anon-key'");
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

// --- Mock Supabase ---------------------------------------------------------

async function mockRows() {
  const raw = JSON.parse(await readFile(path.join(HERE, 'test/fixtures/kras.json'), 'utf8'));
  const val = (t) => { t = (t || '').trim(); if (!t || /^n\/?a$/i.test(t)) return null; if (/^true$/i.test(t)) return 1; if (/^false$/i.test(t)) return 0; return Number(t.replace(/[$,]/g, '')); };
  const kras = [];
  for (const section of ['kra', 'required', 'bonus']) {
    raw[section].forEach(([name, result, goal, points, out_of, met], i) => kras.push({
      id: `${section}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      section, name, result_text: result, goal_text: goal, current: val(result), goal: val(goal), points, out_of, met, sort_order: i,
      kind: /^(true|false)$/i.test(result) || /^(true|false)$/i.test(goal) ? 'boolean' : (result + goal).includes('$') ? 'currency' : 'number',
      term_start: null, due_date: null, note: name === 'RLC Attendance' || name === 'Academics' ? 'Example note, set by hand in Supabase.' : null,
    }));
  }
  const now = Date.now();
  const ics = await readFile(path.join(HERE, 'test/fixtures/chapter.ics'), 'utf8');
  const { rows: events } = calendarRows(ics, { from: new Date(now - 2 * 864e5), to: new Date(now + 15 * 864e5) });
  const snapshots = [];
  for (let d = 20; d >= 0; d--) {
    const day = new Date(now - d * 864e5).toISOString().slice(0, 10);
    for (const k of kras.filter((r) => r.section === 'kra')) {
      const f = (20 - d) / 20;
      snapshots.push({ day, kra_id: k.id, current: k.current == null ? null : Math.round(k.current * f), points: Math.round(k.points * f) });
    }
  }
  return { kras, events, snapshots };
}

function mockSupabase(page, rows, runs, { down = false } = {}) {
  return page.route(`${MOCK_DB}/rest/v1/**`, (route) => {
    if (down) return route.abort('internetdisconnected');
    const u = new URL(route.request().url());
    const table = u.pathname.split('/').pop();
    let body;
    if (table === 'kras') body = rows.kras;
    else if (table === 'events') body = rows.events;
    else if (table === 'kra_snapshots') body = Number(u.searchParams.get('offset') || 0) ? [] : rows.snapshots;
    else if (table === 'rankings') body = [{ id: 'kra', national_rank: 92, national_total: 208, region: '2', region_rank: 30, region_total: 52, score_text: '43.79%', since_yesterday: 24, since_week: -7, prev_year_rank: 37, updated_at: new Date().toISOString() }];
    else if (table === 'sync_runs') body = u.searchParams.get('ok') === 'eq.true' ? [runs.lastOk].filter(Boolean) : [runs.lastRun].filter(Boolean);
    else return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); // goals and board tables: empty
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

// --- Checks ----------------------------------------------------------------

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(1500); // scene fade, bars growing in, fit pass
}

async function tvProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const doc = document.scrollingElement;
    if (doc.scrollHeight > innerHeight + 1) out.push(`page scrolls vertically (${doc.scrollHeight} > ${innerHeight})`);
    if (doc.scrollWidth > innerWidth + 1) out.push(`page scrolls sideways (${doc.scrollWidth} > ${innerWidth})`);
    const scene = document.querySelector('.scene.is-active');
    if (scene.scrollHeight > scene.clientHeight + 1) out.push(`active screen is cut off (${scene.scrollHeight} > ${scene.clientHeight})`);
    for (const c of scene.querySelectorAll('.krow, .list-block, .side, .day, .hero, .tile, .trend')) {
      if (c.scrollHeight > c.clientHeight + 1) out.push(`"${(c.querySelector('h2, .k-title, .eyebrow, .dow')?.textContent || c.className).trim()}" is cut off`);
    }
    // Header pieces must not run into each other.
    const boxes = ['.brand', '#ranks-tv', '.clock'].map((sel) => document.querySelector(sel)).filter((el) => el && el.getClientRects().length).map((el) => el.getBoundingClientRect());
    for (let i = 1; i < boxes.length; i++) if (boxes[i].left < boxes[i - 1].right - 0.5) out.push('header pieces overlap');
    const name = document.querySelector('.chapter');
    if (name.scrollWidth > name.clientWidth + 1) out.push('chapter name is cut off');
    // The stage itself shifts a few px each hour (burn-in), so check what's drawn.
    for (const el of [document.querySelector('.top'), scene, document.getElementById('rotation')]) {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.left < 0 || r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5) out.push(`${el.id || el.className} runs past the screen edge`);
    }
    // Smallest text on the screen, for the 15 ft check.
    let min = Infinity, minText = '';
    for (const el of scene.querySelectorAll('*')) {
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      if (el.closest('[hidden]') || el.getClientRects().length === 0) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < min) { min = fs; minText = el.textContent.trim().slice(0, 30); }
    }
    return { problems: out, minFont: min, minText, dense: scene.className };
  });
}

async function memberProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const doc = document.scrollingElement;
    if (doc.scrollWidth > innerWidth) out.push(`horizontal scroll (${doc.scrollWidth} > ${innerWidth})`);
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > innerWidth + 0.5 && !el.closest('[hidden]')) { out.push(`<${el.tagName.toLowerCase()} class="${el.className.baseVal ?? el.className}"> pokes out to ${Math.round(r.right)}px`); break; }
    }
    return out;
  });
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const { base, close } = await serve();
  const browser = await chromium.launch();
  // Any uncaught error on any page fails the run.
  const pageErrors = [];
  const watch = (page) => { page.on('pageerror', (e) => pageErrors.push(`${page.url()}: ${e.message}`)); return page; };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (opts) => watch(await newPage(opts));
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (opts) => { const ctx = await newContext(opts); ctx.on('page', watch); return ctx; };
  const results = [];
  const record = (name, problems, extra = '') => {
    results.push({ name, problems });
    console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${name}${extra ? '  ' + extra : ''}${problems.length ? '\n        ' + problems.join('\n        ') : ''}`);
  };
  const scenes = ['kras', 'required', 'week'];
  const rows = await mockRows();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  try {
    // TV, sample data, three sizes
    for (const [w, h] of [[1920, 1080], [1280, 720], [3840, 2160]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      for (const scene of scenes) {
        await page.goto(`${base}/Dashboard/?tv&sample&rotate=0&scene=${scene}`);
        await settle(page);
        const r = await tvProblems(page);
        const name = `tv-${w}x${h}-${scene}`;
        if (w === 1920 || w === 1280) await page.screenshot({ path: path.join(OUT, `${name}.png`) });
        record(name, r.problems, `smallest text ${r.minFont}px ("${r.minText}")${/tight/.test(r.dense) ? ' [' + r.dense.replace('scene ', '').replace('is-active', '').trim() + ']' : ''}`);
      }
      await page.close();
    }

    // Members, sample data
    for (const [w, h] of [[390, 844], [1280, 900]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      for (const scene of scenes) {
        await page.goto(`${base}/Dashboard/?sample#${scene}`);
        await settle(page);
        const name = `members-${w}-${scene}`;
        await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
        record(name, await memberProblems(page));
      }
      await page.close();
    }

    // Live path: healthy sync
    {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const runs = { lastRun: { ran_at: iso(20 * 60e3), ok: true, message: 'ok' }, lastOk: { ran_at: iso(20 * 60e3), ok: true, message: 'ok' } };
      await mockSupabase(page, rows, runs);
      for (const scene of scenes) {
        await page.goto(`${base}/Dashboard/live.html?tv&rotate=0&scene=${scene}`);
        await settle(page);
        const r = await tvProblems(page);
        const notices = await page.locator('.notice').allInnerTexts();
        const headline = (await page.locator('#scene-kras .hero-num').innerText().catch(() => '')).replace(/\s+/g, '');
        const problems = [...r.problems, ...notices.map((n) => `unexpected notice: ${n}`)];
        // Fixture totals: KRAs 28 + required 3 + bonus 0.
        if (scene === 'kras' && headline !== '31%') problems.push(`KRA total was "${headline}"`);
        if (scene === 'kras') {
          const h = await page.evaluate(() => ({
            tiles: [...document.querySelectorAll('.tile-num')].map((t) => t.textContent),
            rows: document.querySelectorAll('.krow').length,
            trendLine: !!document.querySelector('.trend .plot path.line'),
            ranks: document.getElementById('ranks-tv').textContent.replace(/\s+/g, ' '),
          }));
          if (h.tiles.join() !== '28/90,3/11,0/10') problems.push(`tiles were ${h.tiles.join()}`);
          if (h.rows !== 9) problems.push(`${h.rows} KRA rows, expected 9`);
          if (!h.trendLine) problems.push('trend line missing');
          if (!/#92 of 208/.test(h.ranks) || !/#30 of 52/.test(h.ranks) || /since|as of/i.test(h.ranks)) problems.push(`ranks were "${h.ranks}"`);
        }
        if (scene === 'week' && !(await page.locator('#nextup .nu-title').count())) problems.push('next-up is missing from the week screen');
        await page.screenshot({ path: path.join(OUT, `live-tv-${scene}.png`) });
        record(`live-tv-${scene}`, problems, scene === 'kras' ? `KRA total ${headline}` : '');
      }
      await page.close();
    }

    // Live path: last sync failed and the last good one is 5 h old
    {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const runs = { lastRun: { ran_at: iso(10 * 60e3), ok: false, message: 'TKE: The TKE site asked for a verification code (MFA) on the page after login. Stopped; the owner needs to sort out MFA for this account.' }, lastOk: { ran_at: iso(5 * 3600e3), ok: true, message: 'ok' } };
      await mockSupabase(page, rows, runs);
      await page.goto(`${base}/Dashboard/live.html?tv&rotate=0&scene=kras`);
      await settle(page);
      const notices = await page.locator('.notice').allInnerTexts();
      const r = await tvProblems(page);
      const want = [/5 hours old/, /last sync failed/];
      const problems = [...r.problems, ...want.filter((re) => !notices.some((n) => re.test(n))).map((re) => `missing notice ${re}`)];
      await page.screenshot({ path: path.join(OUT, 'live-tv-stale-failed.png') });
      record('live-tv-stale-failed', problems, notices.join(' / '));
      await page.close();
    }

    // Live path: database drops after a good load (Wi-Fi drop), then comes back
    {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const runs = { lastRun: { ran_at: iso(15 * 60e3), ok: true }, lastOk: { ran_at: iso(15 * 60e3), ok: true } };
      await mockSupabase(page, rows, runs);
      await page.goto(`${base}/Dashboard/live.html?tv&rotate=0&scene=kras`);
      await settle(page);
      await page.unroute(`${MOCK_DB}/rest/v1/**`);
      await mockSupabase(page, rows, runs, { down: true });
      await page.evaluate(() => window.refresh());
      await page.waitForTimeout(500);
      const downNotices = await page.locator('.notice').allInnerTexts();
      const keptData = (await page.locator('.krow').count()) === 9;
      await page.screenshot({ path: path.join(OUT, 'live-tv-db-down.png') });
      await page.unroute(`${MOCK_DB}/rest/v1/**`);
      await mockSupabase(page, rows, runs);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.waitForTimeout(800);
      const upNotices = await page.locator('.notice').allInnerTexts();
      const problems = [];
      if (!downNotices.some((n) => /Can't reach the database. Showing data from/.test(n))) problems.push(`no "can't reach" notice: ${downNotices.join(' / ')}`);
      if (!keptData) problems.push('lost the last good data while offline');
      if (upNotices.length) problems.push(`notice still showing after reconnect: ${upNotices.join(' / ')}`);
      record('live-wifi-drop-and-recover', problems, downNotices.join(' / '));
      await page.close();
    }

    // Live path: cold start with the database down and nothing cached
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await mockSupabase(page, rows, {}, { down: true });
      await page.goto(`${base}/Dashboard/live.html#kras`);
      await settle(page);
      const notices = await page.locator('.notice').allInnerTexts();
      const problems = await memberProblems(page);
      if (!notices.some((n) => /Can't reach the database/.test(n))) problems.push('no unreachable notice');
      await page.screenshot({ path: path.join(OUT, 'live-members-390-cold-offline.png'), fullPage: true });
      record('live-members-390-cold-offline', problems, notices.join(' / '));
      await ctx.close();
    }

    // The service-role key must never be usable from the page.
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const fakeServiceJwt = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ iss: 'supabase', role: 'service_role' }), 'not-a-real-signature'].join('.');
      await page.route(`${base}/Dashboard/keytest.html`, async (route) => {
        const html = (await readFile(path.join(ROOT, 'Dashboard/index.html'), 'utf8'))
          .replace(/supabaseUrl: '[^']*'/, `supabaseUrl: '${MOCK_DB}'`).replace(/supabaseAnonKey: '[^']*'/, `supabaseAnonKey: '${fakeServiceJwt}'`);
        route.fulfill({ status: 200, contentType: 'text/html', body: html });
      });
      let called = false;
      await page.route(`${MOCK_DB}/**`, (route) => { called = true; route.abort(); });
      await page.goto(`${base}/Dashboard/keytest.html`);
      await settle(page);
      const notices = await page.locator('.notice').allInnerTexts();
      const problems = [];
      if (called) problems.push('page used a service-role key');
      if (!notices.some((n) => /secret Supabase key/.test(n))) problems.push('no warning about the secret key');
      record('refuses-service-role-key', problems);
      await page.close();
    }
    record('no-script-errors', pageErrors);
  } finally {
    await browser.close();
    close();
  }

  const failed = results.filter((r) => r.problems.length);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${path.relative(process.cwd(), OUT) || OUT}/`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
