import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { calendarRows } from '../lib/calendar.mjs';
import { parseKraTables, parseValue, dotState, slugify } from '../lib/kra.mjs';
import { scrapeTke, scrapeFile, inSession, scrubSession, StopError } from '../lib/tke.mjs';
import { startMockTke, kraTablesHtml, TEST_USER, TEST_PASS } from './mock-tke.mjs';

const fixture = (f) => new URL(`./fixtures/${f}`, import.meta.url);

describe('calendar', () => {
  const ics = readFileSync(fixture('chapter.ics'), 'utf8');
  const { rows, skipped } = calendarRows(ics, { from: new Date('2026-10-29T00:00:00Z'), to: new Date('2026-11-14T00:00:00Z') });
  const find = (title) => rows.filter((r) => r.title === title);

  test('weekly event keeps its local time across the Nov 1 DST change', () => {
    const meetings = find('Chapter meeting').map((r) => r.starts_at);
    // 7 PM EST = 00:00 UTC next day (it was 23:00 UTC while on EDT)
    assert.deepEqual(meetings, ['2026-11-02T00:00:00.000Z', '2026-11-09T00:00:00.000Z']);
  });

  test('EXDATE removes that instance only', () => {
    const eboard = find('Executive board').map((r) => r.starts_at);
    assert.ok(!eboard.includes('2026-11-05T01:00:00.000Z'));
    assert.ok(eboard.includes('2026-11-12T01:00:00.000Z'));
  });

  test('a moved instance shows at its new time, not its old one', () => {
    assert.equal(find('Brotherhood night (moved to Friday)')[0]?.starts_at, '2026-11-07T02:00:00.000Z');
    assert.ok(!find('Brotherhood night').some((r) => r.starts_at === '2026-11-06T01:00:00.000Z'));
    // moved into the window from outside it
    assert.equal(find('Alumni call (moved up)')[0]?.starts_at, '2026-11-06T21:00:00.000Z');
  });

  test('cancelled events and cancelled instances are dropped', () => {
    assert.equal(find('Cancelled mixer').length, 0);
    assert.ok(!find('Beach cleanup').some((r) => r.starts_at.startsWith('2026-10-31')));
    assert.equal(find('Beach cleanup').length, 1);
    assert.equal(skipped.cancelled, 2);
  });

  test('all-day events are stored as dates at 00:00 UTC with an exclusive end', () => {
    assert.deepEqual(find('Election day')[0], {
      id: 'election@test|2026-11-03T00:00:00.000Z', title: 'Election day',
      starts_at: '2026-11-03T00:00:00.000Z', ends_at: '2026-11-04T00:00:00.000Z', all_day: true, location: null,
    });
    assert.equal(find('Homecoming weekend')[0].ends_at, '2026-11-02T00:00:00.000Z');
    assert.equal(find('Dues reminder').length, 2);
  });

  test('UTC events pass through and private events are skipped', () => {
    assert.equal(find('Nationals call')[0].starts_at, '2026-11-02T15:00:00.000Z');
    assert.equal(find('Private thing').length, 0);
  });
});

describe('KRA parsing helpers', () => {
  test('parseValue', () => {
    assert.equal(parseValue('$8,000.00'), 8000);
    assert.equal(parseValue('520.00'), 520);
    assert.equal(parseValue('True'), 1);
    assert.equal(parseValue('False'), 0);
    assert.equal(parseValue('N/A'), null);
    assert.equal(parseValue(''), null);
    assert.equal(parseValue('85%'), 85);
  });

  test('dotState reads images, classes and colors without false alarms', () => {
    assert.equal(dotState({ hints: '/images/green-dot.png' }), true);
    assert.equal(dotState({ hints: 'circle_red.png' }), false);
    assert.equal(dotState({ hints: 'goal not met' }), false);
    assert.equal(dotState({ hints: 'fa fa-check' }), true);
    assert.equal(dotState({ hints: 'table-bordered text-center', colors: [] }), null);
    assert.equal(dotState({ hints: '', colors: ['rgb(46, 125, 50)'] }), true);
    assert.equal(dotState({ hints: '', colors: ['rgb(198, 40, 40)'] }), false);
  });

  test('slugify makes stable ids', () => {
    assert.equal(slugify('St. Jude Dollars'), 'st-jude-dollars');
    assert.equal(slugify('Risk Management & Education'), 'risk-management-and-education');
  });
});

function checkParsed(raw) {
  const { rows, totals, warnings } = parseKraTables(raw);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    Object.fromEntries(Object.entries(totals).map(([s, t]) => [s, `${t.points}/${t.out_of} ${t.met}/${t.count}`])),
    { kra: '28/90 2/9', required: '3/11 1/5', bonus: '0/10 0/4' },
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId['kra-st-jude-dollars'].kind, 'currency');
  assert.equal(byId['kra-st-jude-dollars'].current, 165);
  assert.equal(byId['kra-st-jude-dollars'].goal, 8000);
  assert.equal(byId['kra-st-jude-dollars'].points, 0.1);
  assert.equal(byId['kra-edu-tke-org-usage'].points, 0.9);
  assert.equal(byId['kra-service'].goal, 1300);
  assert.equal(byId['kra-finances'].kind, 'currency');
  assert.equal(byId['kra-finances'].goal, 0);
  assert.equal(byId['kra-finances'].met, true);
  assert.equal(byId['required-academics'].current, null);
  assert.equal(byId['required-annual-report'].kind, 'boolean');
  assert.equal(byId['required-annual-report'].met, false);
  assert.equal(byId['required-alumni-engagement'].met, true);
  assert.equal(byId['required-chapter-advisor'].kind, 'boolean');
  assert.equal(byId['required-chapter-advisor'].current, null);
  assert.equal(byId['required-ritual-equip-check'].name, 'Ritual Equip. Check');
  assert.equal(byId['bonus-money-vehicle'].goal, null);
  assert.equal(byId['bonus-money-vehicle'].goal_text, '');
  assert.equal(rows.filter((r) => r.section === 'kra').map((r) => r.sort_order).join(), '0,1,2,3,4,5,6,7,8');
  return rows;
}

describe('TKE scrape (mock site)', { timeout: 120_000 }, () => {
  test('saved page parses to the right rows and totals', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kra-'));
    const file = path.join(dir, 'kra.html');
    writeFileSync(file, `<!doctype html><meta charset="utf-8"><body>${kraTablesHtml()}</body>`);
    checkParsed(await scrapeFile(file));
  });

  for (const mode of ['normal', 'bounce']) {
    test(`logs in and reads JS-drawn tables (${mode})`, async () => {
      const mock = await startMockTke({ mode });
      try {
        const raw = await scrapeTke({ config: mock.config, username: TEST_USER, password: TEST_PASS, log: () => {} });
        checkParsed(raw);
        assert.equal(mock.stats.loginPosts, mode === 'bounce' ? 2 : 1);
      } finally { await mock.close(); }
    });
  }

  test('module.tke.org style: session id in the URL is reused and never logged', async () => {
    const mock = await startMockTke({ mode: 'cookieless' });
    const lines = [];
    try {
      const raw = await scrapeTke({ config: mock.config, username: TEST_USER, password: TEST_PASS, log: (l) => lines.push(l) });
      checkParsed(raw);
      assert.equal(mock.stats.loginPosts, 1);
      assert.ok(mock.stats.sessions.length >= 1);
      for (const id of mock.stats.sessions) assert.ok(!lines.join('\n').includes(id), `log leaked session id: ${lines.join(' / ')}`);
      assert.ok(lines.some((l) => l.includes('/(session)/KRA.aspx')), lines.join(' / '));

      // A wrong page fails, and the error names the page without the session id.
      // Past sign-in there's no screenshot (public artifact), only the page's outline.
      const debugDir = mkdtempSync(path.join(tmpdir(), 'tke-debug-'));
      const err = await scrapeTke({ config: { ...mock.config, kraUrl: mock.config.kraUrl.replace('KRA.aspx', 'Nope.aspx'), waitForTableSeconds: 2 }, username: TEST_USER, password: TEST_PASS, debugDir, log: (l) => lines.push(l) })
        .then(() => null, (e) => e);
      assert.ok(err, 'expected a failure on a page with no KRA tables');
      assert.match(err.message, /\/\(session\)\/Nope\.aspx/);
      for (const id of mock.stats.sessions) assert.ok(!(err.message + lines.join('\n')).includes(id));
      assert.ok(!existsSync(path.join(debugDir, 'tke-debug.png')), 'no screenshot after signing in');
      assert.ok(lines.some((l) => /no screenshot.*"Not found": 0 table/.test(l)), lines.join(' / '));
    } finally { await mock.close(); }
  });

  test('inSession swaps a copied session id for the current one', () => {
    assert.equal(inSession('https://m.test/(S(old))/KRA.aspx?x=1', 'https://m.test/(S(new))/Default.aspx'), 'https://m.test/(S(new))/KRA.aspx?x=1');
    assert.equal(inSession('https://m.test/(S(old))/KRA.aspx', 'about:blank'), 'https://m.test/KRA.aspx');
    assert.equal(inSession('https://m.test/Chapter/KRA', 'https://m.test/Home'), 'https://m.test/Chapter/KRA');
    assert.equal(scrubSession('at https://m.test/(A(x1)S(y2))/a.aspx'), 'at https://m.test/(session)/a.aspx');
  });

  for (const mode of ['mfa', 'captcha']) {
    test(`stops at ${mode} instead of getting around it`, async () => {
      const mock = await startMockTke({ mode });
      try {
        await assert.rejects(
          scrapeTke({ config: mock.config, username: TEST_USER, password: TEST_PASS, log: () => {} }),
          (e) => e instanceof StopError,
        );
        if (mode === 'captcha') assert.equal(mock.stats.loginPosts, 0);
      } finally { await mock.close(); }
    });
  }

  test('a rejected password fails once and does not retry', async () => {
    const mock = await startMockTke({ mode: 'badlogin' });
    try {
      await assert.rejects(
        scrapeTke({ config: mock.config, username: TEST_USER, password: TEST_PASS, log: () => {} }),
        /Login didn't go through/,
      );
      assert.equal(mock.stats.loginPosts, 1);
    } finally { await mock.close(); }
  });

  test('unset URLs fail with a clear message', async () => {
    await assert.rejects(scrapeTke({ config: { loginUrl: 'FILL_ME', kraUrl: 'FILL_ME' }, username: 'a', password: 'b' }), /not set in sync\/tke.config.json/);
  });
});
