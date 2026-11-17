#!/usr/bin/env node
// Drive the members' app in a real browser against the LOCAL Supabase:
// sign-up, profile, goals, the board, admin screens, and what a visitor sees.
//
//   node ../.local/serve.mjs &            (local preview on :4173)
//   set -a; . ../.local/env.local; set +a; node app-check.mjs
//
// Screenshots land in sync/.shots/app/.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.shots', 'app');
const BASE = process.env.APP_URL || 'http://localhost:4173/Dashboard/';
const API = process.env.API_URL, SERVICE = process.env.SERVICE_ROLE_KEY;
if (!API || !SERVICE || !/127\.0\.0\.1|localhost/.test(API)) { console.error('Point this at the local Supabase: set -a; . ../.local/env.local; set +a'); process.exit(2); }
const admin = createClient(API, SERVICE, { auth: { persistSession: false } });

let passed = 0, failed = 0;
const ok = (cond, msg, detail = '') => { if (cond) { passed++; console.log(`ok    ${msg}`); } else { failed++; console.log(`FAIL  ${msg}${detail ? `\n        ${detail}` : ''}`); } };
const errors = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
const inDays = (n) => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data?.users || []) if (/\.test@(my\.)?fit\.edu$/i.test(u.email || '')) await admin.auth.admin.deleteUser(u.id);
  await admin.from('issues').delete().or('title.like.E2E%,title.like.<img%');
  await admin.from('goals').delete().like('title', 'E2E%');
  await admin.from('custom_fields').delete().like('name', 'E2E%');
  await admin.from('event_history').delete().like('title', 'E2E%'); // takes its check-ins with it
  await admin.from('events').delete().like('title', 'E2E%');
  await admin.from('teams').delete().like('name', 'E2E%');
  await admin.from('budget_lines').delete().like('name', 'E2E%');
  const { data: pnms } = await admin.from('pnms').select('id, photo_path').like('email', '%.test@%');
  for (const p of pnms || []) if (p.photo_path) await admin.storage.from('pnm-photos').remove([p.photo_path]);
  if (pnms?.length) await admin.from('pnms').delete().in('id', pnms.map((p) => p.id));
}

const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
};
const sheet = (page) => page.locator('.sheet-back').last();
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const noSideScroll = async (page, what) => ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${what}: no sideways page scroll`);
// Navigation: Metrics, This week, Quick (and Recruit). Metrics opens a menu of
// Scoreboard, Required & bonus, Goals and Board. Works on a phone or a desktop.
const metrics = async (page, scene) => {
  const tab = page.locator('#gtab-metrics:visible, #tab-metrics:visible').first();
  await tab.click();
  await page.locator(`#metrics-menu [data-scene="${scene}"]`).click();
  await page.locator(`#scene-${scene}`).waitFor();
};
const toGoals = (page) => metrics(page, 'goals');
const toBoard = (page) => metrics(page, 'board');
const toSettings = async (page) => { await page.locator('#account .acct-btn').click(); await page.locator('#scene-settings .set-card').first().waitFor(); };
const closeSheets = async (page) => { while (await page.locator('.sheet-back').count()) await page.locator('.sheet-back').last().locator('[data-sheet="close"]').click(); };
const toastGone = (page) => page.locator('.toast').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});

async function signIn(page, email, scroll) {
  await page.locator('#account [data-act="signin"]').click();
  await sheet(page).locator('[name="email"]').fill(email);
  await sheet(page).locator('[name="scroll"]').fill(String(scroll));
  await sheet(page).locator('[data-sheet="primary"]').click();
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await cleanup();
  const browser = await chromium.launch();
  const phone = await browser.newContext({ ...devices['iPhone 14'] });
  const page = await phone.newPage();
  watch(page, 'phone');

  // ---- Visitor on a phone -------------------------------------------------
  await page.goto(BASE + '#goals');
  await page.locator('#scene-goals .app-head').waitFor();
  ok((await page.locator('#gtabs .gtab:visible').allInnerTexts()).map((t) => t.replace('▾', '').trim()).join() === 'Metrics,This week,Quick', 'phone: three bottom tabs for a visitor: Metrics, This week, Quick');
  ok(await page.locator('#gtabs').evaluate((el) => getComputedStyle(el).position === 'fixed' && el.getBoundingClientRect().bottom >= innerHeight - 1), 'phone: the tabs are a bar fixed to the bottom');
  ok(await page.locator('.gtab svg').first().isVisible() && !(await page.locator('#tabs').isVisible()), 'phone: tabs have icons, and the desktop tab row is hidden');
  ok(await page.locator('#gtab-metrics').getAttribute('aria-selected') === 'true', 'phone: Goals sits under the Metrics tab');
  await page.locator('#gtab-metrics').click();
  const menu = page.locator('#metrics-menu');
  ok(await menu.isVisible() && (await menu.locator('.menu-item').allInnerTexts()).map((t) => t.replace('✓', '').trim()).join() === 'Scoreboard,Required & bonus,Goals,Board', 'phone: the Metrics tab opens a menu: Scoreboard, Required & bonus, Goals, Board');
  ok(await menu.locator('[aria-checked="true"]').innerText().then((t) => /Goals/.test(t)), 'phone: the menu ticks the screen you are on');
  ok(await menu.evaluate((el) => { const r = el.getBoundingClientRect(), bar = document.getElementById('gtabs').getBoundingClientRect(); return r.bottom <= bar.top + 1 && r.left >= 0 && r.right <= innerWidth; }), 'phone: the menu opens above the bottom bar, on screen');
  await shot(page, 'phone-metrics-menu');
  await page.locator('#scene-goals .app-head').click();
  ok(!(await menu.isVisible()) && await page.locator('#scene-goals').isVisible(), 'phone: tapping elsewhere closes the menu without changing screen');
  await metrics(page, 'kras');
  ok(await page.locator('#scene-kras').isVisible() && !(await page.locator('#scene-required').isVisible()) && !(await menu.isVisible()), 'phone: picking Scoreboard shows just the scoreboard');
  ok(await page.locator('#ranks-m .rk').isVisible(), 'phone: rankings show with the scoreboard');
  await noSideScroll(page, 'Scoreboard');
  await shot(page, 'phone-kra-tab');
  await metrics(page, 'required');
  ok(await page.locator('#scene-required').isVisible() && !(await page.locator('#scene-kras').isVisible()) && await page.locator('#ranks-m .rk').isVisible(), 'phone: Required & bonus is its own screen, with the rankings');
  await page.locator('#gtab-metrics').click();
  await page.keyboard.press('Escape');
  ok(!(await menu.isVisible()), 'the menu closes with Escape');
  await page.locator('#gtab-week').click();
  ok(await page.locator('#scene-week').isVisible() && !(await page.locator('#scene-kras').isVisible()), 'phone: This week is its own tab');
  ok(!(await page.locator('#ranks-m').isVisible()), 'phone: no rankings on This week');
  // Tap a calendar event for its details.
  const firstEvent = page.locator('#scene-week .ev[data-ev]').first();
  const evTitle = (await firstEvent.locator('.ev-title').innerText()).trim();
  await firstEvent.click();
  const pop = page.locator('#event-pop .pop');
  await pop.waitFor();
  ok((await pop.locator('h2').innerText()).trim() === evTitle && /Starts in|Happening now|Ended/i.test(await pop.locator('.pop-status').innerText()) && /day|All day|AM|PM/i.test(await pop.innerText()), 'phone: tapping a calendar event opens its details', (await pop.innerText()).replace(/\n/g, ' | '));
  await page.waitForTimeout(400); // let it finish sliding up
  ok(await pop.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5; }), 'phone: the event details fit on the screen');
  await shot(page, 'phone-event-detail');
  await pop.locator('.pop-close').click();
  ok(await page.locator('#event-pop').count() === 0, 'the event details close');
  await firstEvent.focus();
  await page.keyboard.press('Enter');
  await pop.waitFor();
  await page.keyboard.press('Escape');
  ok(await page.locator('#event-pop').count() === 0, 'events open with Enter and close with Escape');
  await toGoals(page);
  ok(await page.locator('#scene-goals').isVisible() && await page.locator('#gtab-metrics').getAttribute('aria-selected') === 'true', 'phone: Metrics › Goals opens the goals');
  ok(!(await page.locator('#ranks-m').isVisible()), 'phone: no rankings on Goals');
  ok(await page.locator('#account [data-act="signin"]').isVisible(), 'visitor sees a Sign in button');
  ok(await page.locator('#scene-goals .app-head h2').innerText() === 'Goals' && await page.locator('#scene-goals .goal-list, #scene-goals .app-note').count() === 1, 'visitor sees the goals list (or the empty note)');
  await noSideScroll(page, 'goals (visitor)');
  await toBoard(page);
  await page.locator('#scene-board .col').first().waitFor();
  ok(await page.locator('#scene-board .col').count() === 4, 'board shows the four starting columns');
  ok(await page.locator('#scene-board .col-add').count() === 0, 'visitor gets no "add an issue" buttons');
  ok(await page.locator('.col').first().evaluate((el) => el.getBoundingClientRect().width / innerWidth) > 0.75, 'phone: one column nearly fills the screen');
  await noSideScroll(page, 'board (visitor)');
  ok(await page.locator('link[rel="manifest"]').count() === 1 && (await page.request.get(BASE + 'manifest.webmanifest')).ok(), 'home-screen app manifest is served');
  ok((await page.request.get(BASE + 'icons/icon-180.png')).ok(), 'home-screen icon is served');

  // ---- Sign-in form errors ----------------------------------------------------
  await signIn(page, 'someone@gmail.com', 9002);
  ok(/fit\.edu/.test(await sheet(page).locator('.form-error').innerText()), 'sign-in: a non-FIT email gets a clear message');
  await sheet(page).locator('[name="email"]').fill('admin.test@fit.edu');
  await sheet(page).locator('[name="scroll"]').fill('4242');
  await sheet(page).locator('[data-sheet="primary"]').click();
  await page.waitForFunction(() => /chapter scroll/.test(document.querySelector('.sheet-back:last-of-type .form-error')?.textContent || ''));
  ok(true, 'sign-in: an unknown scroll number gets a clear message');
  ok(await sheet(page).locator('[name="email"]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 16), 'inputs use 16px text, so iOS will not zoom the page');
  await shot(page, 'phone-signin');

  // ---- First sign-in: account + profile -----------------------------------------
  await sheet(page).locator('[name="scroll"]').fill('9002');
  await sheet(page).locator('[data-sheet="primary"]').click();
  await page.locator('.sheet-title', { hasText: 'Set up your profile' }).waitFor();
  ok(await sheet(page).locator('[name="name"]').inputValue() === 'Test Brother 9002', 'first sign-in opens the profile screen, name filled in from the scroll');
  ok(/visible to anyone/.test(await sheet(page).innerText()), 'profile screen says the name, year and photo are public');
  await sheet(page).locator('[name="name"]').fill('Alex Admin');
  await sheet(page).locator('[name="grad_year"]').fill('2027');
  await sheet(page).locator('[name="photo"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png });
  await sheet(page).locator('#photo-preview img').waitFor();
  await shot(page, 'phone-profile');
  await sheet(page).locator('[data-sheet="primary"]').click();
  await page.locator('#account .acct-btn img').waitFor();
  ok(true, 'profile saved; the header shows the uploaded photo');
  { const { data } = await admin.from('profiles').select('name, grad_year, avatar_path, is_admin').eq('name', 'Alex Admin').single(); ok(data && data.grad_year === 2027 && /\.jpg$/.test(data.avatar_path || '') && data.is_admin, 'database has the name, year, photo and admin flag', JSON.stringify(data)); }
  await toastGone(page);

  // ---- Sign out, wrong scroll number, sign back in ---------------------------------
  await toSettings(page);
  ok(/Alex Admin/.test(await page.locator('#scene-settings').innerText()) && /admin\.test@fit\.edu/.test(await page.locator('#scene-settings').innerText()), 'tapping the profile photo opens Settings, with your profile');
  ok(await page.locator('#gtabs .gtab[aria-selected="true"]').count() === 0, 'Settings is not one of the three tabs');
  await shot(page, 'phone-settings');
  await page.locator('#scene-settings [data-set="signout"]').click();
  await page.locator('#account [data-act="signin"]').waitFor();
  await signIn(page, 'admin.test@fit.edu', 9004);
  await page.waitForFunction(() => /doesn't match/.test(document.querySelector('.sheet-back:last-of-type .form-error')?.textContent || ''));
  ok(true, 'sign-in: the wrong scroll number is refused with a clear message');
  await sheet(page).locator('[name="scroll"]').fill('9002');
  await sheet(page).locator('[data-sheet="primary"]').click();
  await page.locator('#account .acct-btn').waitFor();
  ok(true, 'sign-in works with the right scroll number');
  await toastGone(page);

  // ---- Admin: a committee and a custom field ------------------------------------------
  await toSettings(page);
  await page.locator('#scene-settings [data-go="teams"]').click();
  await sheet(page).locator('[data-new="committee"]').click();
  await sheet(page).locator('[name="name"]').fill('E2E Philanthropy Committee');
  await sheet(page).locator('[data-sheet="primary"]').click();
  await sheet(page).locator('.rowi-title', { hasText: 'E2E Philanthropy Committee' }).waitFor();
  ok(true, 'admin can add a committee');
  await sheet(page).locator('[data-sheet="close"]').click();
  await page.locator('#scene-settings [data-go="fields"]').click();
  await sheet(page).locator('[data-new]').click();
  await sheet(page).locator('[name="name"]').fill('E2E Budget');
  await sheet(page).locator('[name="type"]').selectOption('number');
  await sheet(page).locator('[name="show_on_card"]').check();
  await sheet(page).locator('[data-sheet="primary"]').click();
  await sheet(page).locator('.rowi-title', { hasText: 'E2E Budget' }).waitFor();
  ok(true, 'admin can add a custom field');
  await shot(page, 'phone-admin-fields');
  await sheet(page).locator('[data-sheet="close"]').click();

  // ---- Goals ---------------------------------------------------------------------------
  await toGoals(page);
  await page.locator('[data-goal-new]').click();
  await sheet(page).locator('[name="title"]').fill('E2E Raise $8,000 for St. Jude');
  await sheet(page).locator('[name="kra_id"]').selectOption('kra-st-jude-dollars');
  ok(await sheet(page).locator('[name="target_value"]').inputValue() === '8000' && await sheet(page).locator('[name="unit"]').inputValue() === 'currency', 'following a KRA fills in the unit and target');
  await sheet(page).locator('[name="start_value"]').fill('0');
  await sheet(page).locator('[name="start_date"]').fill('2026-06-01');
  await sheet(page).locator('[data-sheet="primary"]').click();
  await page.waitForFunction(() => /due date/i.test(document.querySelector('.sheet-back:last-of-type .form-error')?.textContent || ''));
  ok(true, 'a goal cannot be saved without a due date');
  await sheet(page).locator('[name="due_date"]').fill('2027-05-31');
  await shot(page, 'phone-goal-form');
  await sheet(page).locator('[data-sheet="primary"]').click();
  const stj = page.locator('.gcard', { hasText: 'E2E Raise $8,000' });
  await stj.waitFor();
  ok(/\$3,760\s+of \$8,000/.test(await stj.locator('.g-val').innerText()), 'a KRA-linked goal shows the synced number with no typing', await stj.locator('.g-val').innerText());
  ok(/On pace|Behind pace/.test(await stj.locator('.st').innerText()), 'the goal shows whether it is on pace');
  await toastGone(page);

  await page.locator('[data-goal-new]').click();
  await sheet(page).locator('[name="title"]').fill('E2E Recruit 10 new members');
  await sheet(page).locator('[name="target_value"]').fill('10');
  await sheet(page).locator('[name="owner_team_id"]').selectOption({ label: 'Rush Chairman' });
  await sheet(page).locator('[name="due_date"]').fill(inDays(60));
  await sheet(page).locator('[data-sheet="primary"]').click();
  const rec = page.locator('.gcard', { hasText: 'E2E Recruit' });
  await rec.waitFor();
  await toastGone(page);
  await rec.click();
  await sheet(page).locator('[name="value"]').fill('4');
  await sheet(page).locator('[name="note"]').fill('Fall rush week 1');
  await sheet(page).locator('[data-do="checkin"]').click();
  await page.waitForFunction(() => /^4\s*of 10/.test(document.querySelector('.sheet-back:last-of-type .g-val')?.innerText || ''));
  ok(true, 'a check-in moves a manual goal (4 of 10)');
  await sheet(page).locator('.act li').first().waitFor();
  ok(/Alex Admin/.test(await sheet(page).locator('.act').innerText()), 'the goal lists who made each change');
  await shot(page, 'phone-goal-detail');
  await sheet(page).locator('[data-sheet="close"]').click();
  await shot(page, 'phone-goals');
  await noSideScroll(page, 'goals (member)');

  // ---- Board -------------------------------------------------------------------------------
  await toBoard(page);
  await page.locator('[data-issue-new]').first().click();
  await sheet(page).locator('[name="title"]').fill('E2E Book venue for the St. Jude gala');
  await sheet(page).locator('[name="goal_id"]').selectOption({ label: 'E2E Raise $8,000 for St. Jude' });
  await sheet(page).locator('[name="due_date"]').fill(inDays(5));
  await sheet(page).locator('label.check', { hasText: 'E2E Philanthropy Committee' }).click();
  await sheet(page).locator('label.check', { hasText: 'Social Chair' }).click();
  await sheet(page).locator('[data-do="link"]').click();
  await sheet(page).locator('[data-link="label"]').fill('Venue plan');
  await sheet(page).locator('[data-link="url"]').fill('javascript:alert(1)');
  await sheet(page).locator('.field', { hasText: 'E2E Budget' }).locator('input').fill('250');
  await sheet(page).locator('[data-sheet="primary"]').click();
  await page.waitForFunction(() => /web address/.test(document.querySelector('.sheet-back:last-of-type .form-error')?.textContent || ''));
  ok(true, 'a javascript: link is refused by the form');
  await sheet(page).locator('[data-link="url"]').fill('docs.google.com/document/d/abc');
  await shot(page, 'phone-issue-form');
  await sheet(page).locator('[data-sheet="primary"]').click();
  const card = page.locator('.icard', { hasText: 'E2E Book venue' });
  await card.waitFor();
  const cardText = await card.innerText();
  ok(/↳ E2E Raise/.test(cardText) && /E2E Philanthropy Committee/.test(cardText) && /Social Chair/.test(cardText) && /Due /.test(cardText) && /1 link/.test(cardText) && /E2E Budget: 250/.test(cardText), 'the card shows its goal, both assignees, deadline, link count and the custom field', cardText.replace(/\n/g, ' | '));
  ok(await page.locator('.col').first().locator('.icard', { hasText: 'E2E Book venue' }).count() === 1, 'a new issue lands in the first column');
  await toastGone(page);

  // Script injection: a title full of markup must show as plain text.
  await page.locator('[data-issue-new]').first().click();
  await sheet(page).locator('[name="title"]').fill('<img src=x onerror=window.__xss=1>');
  await sheet(page).locator('[data-sheet="primary"]').click();
  await page.locator('.icard', { hasText: '<img src=x' }).waitFor();
  ok(await page.evaluate(() => window.__xss === undefined) && await page.locator('#scene-board img').count() === 0, 'markup typed into a title is shown as text, never run');
  await toastGone(page);

  // Move by opening the card and picking a column.
  await card.click();
  await sheet(page).locator('[name="column_id"]').selectOption({ label: 'Doing' });
  await sheet(page).locator('[data-sheet="primary"]').click();
  await page.locator('.col[aria-label="Doing"] .icard', { hasText: 'E2E Book venue' }).waitFor();
  ok(true, 'an issue moves when you pick another column in its sheet');
  await toastGone(page);
  await page.locator('[data-col-pill]', { hasText: 'Doing' }).click();
  await page.waitForTimeout(700);
  ok(await page.locator('.col[aria-label="Doing"]').evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= -2 && r.left < innerWidth * 0.2; }), 'phone: tapping a column pill slides to that column');
  await shot(page, 'phone-board');
  await noSideScroll(page, 'board (member)');

  // Filters.
  await page.locator('#board-team').selectOption({ label: 'E2E Philanthropy Committee' });
  ok(await page.locator('.icard').count() === 1, 'filtering by committee leaves only its issue');
  await page.locator('#board-team').selectOption('');
  await page.locator('#board-q').fill('E2E Book');
  ok(await page.locator('.icard').count() === 1 && await page.locator('#board-q').evaluate((el) => document.activeElement === el), 'search filters as you type and keeps the cursor in the box');
  await page.locator('#board-q').fill('');

  // The goal now counts its issue.
  await toGoals(page);
  ok(/1 open issue/.test(await stj.innerText()), 'the goal card counts its open issue');

  // ---- Desktop: side-by-side columns and drag ---------------------------------------------------
  // The TV has nobody to tap it: its events are plain text.
  { const tv = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); watch(tv, 'tv');
    await tv.goto(BASE + '?tv&rotate=0&scene=week'); await tv.locator('#scene-week .ev').first().waitFor();
    ok(await tv.locator('#scene-week .ev[data-ev]').count() === 0, 'TV: calendar events are not tappable'); await tv.close(); }
  const desk = await browser.newContext({ viewport: { width: 1280, height: 860 }, storageState: await phone.storageState() });
  const dp = await desk.newPage();
  watch(dp, 'desktop');
  await dp.goto(BASE + '#board');
  const dcard = dp.locator('.icard', { hasText: 'E2E Book venue' });
  await dcard.waitFor();
  ok(await dp.locator('.col').evaluateAll((els) => els.every((el) => el.getBoundingClientRect().right <= innerWidth)), 'desktop: all columns fit side by side');
  ok(!(await dp.locator('#ranks-m').isVisible()), 'desktop: no rankings on the Board');
  ok(await dp.locator('#tabs .tab:not(.needs-recruit)').count() === 3 && await dp.locator('#tabs').evaluate((el) => getComputedStyle(el).position !== 'fixed') && !(await dp.locator('#gtabs').isVisible()), 'desktop: three tabs across the top (Metrics, This week, Quick access), no bottom bar');
  ok(/Metrics · Board/.test(await dp.locator('#tab-metrics').innerText()), 'desktop: the Metrics tab names the screen it shows');
  await dp.locator('#tab-metrics').click();
  ok(await dp.locator('#metrics-menu').evaluate((el) => el.getBoundingClientRect().top >= document.getElementById('tab-metrics').getBoundingClientRect().bottom - 1), 'desktop: the menu drops down under the tab');
  await shot(dp, 'desktop-metrics-menu');
  await dp.keyboard.press('ArrowDown');
  await dp.keyboard.press('Enter');
  await dp.locator('#scene-goals').waitFor({ state: 'hidden' }).catch(() => {});
  ok(await dp.locator('#metrics-menu').isHidden(), 'desktop: the menu works from the keyboard');
  await metrics(dp, 'kras');
  await dp.locator('#ranks-m .rk').first().waitFor({ timeout: 5000 }).catch(() => {});
  ok(await dp.locator('#ranks-m .rk').first().isVisible(), 'desktop: rankings show with the scoreboard');
  await metrics(dp, 'required');
  ok(await dp.locator('#ranks-m .rk').first().isVisible(), 'desktop: rankings show with Required & bonus');
  await dp.locator('#tab-week').click();
  ok(!(await dp.locator('#ranks-m').isVisible()), 'desktop: no rankings on This week');
  await dp.goto(BASE + '#board');
  await dcard.waitFor();
  await dcard.scrollIntoViewIfNeeded();
  const from = await dcard.boundingBox(), to = await dp.locator('.col[aria-label="Done"] .col-list').boundingBox();
  await dp.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await dp.mouse.down();
  await dp.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  // Aim inside the part of the Done column that's on screen: after scrolling to the card,
  // the top of a short column can be above the window.
  const dropY = Math.min(Math.max(to.y + 24, 60), to.y + to.height - 12);
  await dp.mouse.move(to.x + to.width / 2, dropY, { steps: 14 });
  await dp.mouse.up();
  await dp.locator('.col[aria-label="Done"] .icard', { hasText: 'E2E Book venue' }).waitFor({ timeout: 8000 }).catch(() => {});
  await dp.waitForTimeout(600);
  { const { data } = await admin.from('issues').select('column_id, board_columns(name)').like('title', 'E2E Book venue%').single(); ok(data?.board_columns?.name === 'Done', 'dragging a card to another column saves the move', JSON.stringify(data)); }
  await shot(dp, 'desktop-board');
  await dp.goto(BASE + '#goals');
  await dp.locator('.gcard').first().waitFor();
  await shot(dp, 'desktop-goals');
  await desk.close();

  // ---- Archive and restore ------------------------------------------------------------------------
  await toBoard(page);
  await page.locator('.icard', { hasText: '<img src=x' }).click();
  await sheet(page).locator('[data-do="archive"]').click();
  await sheet(page).locator('[data-sheet="primary"]').click();
  await page.locator('.icard', { hasText: '<img src=x' }).waitFor({ state: 'detached' });
  ok(true, 'archiving takes an issue off the board');
  await toastGone(page);
  await toSettings(page);
  await page.locator('#scene-settings [data-go="archive"]').click();
  await sheet(page).locator('[data-restore^="issues:"]').first().click();
  await sheet(page).locator('[data-restore^="issues:"]').first().waitFor({ state: 'detached' });
  await sheet(page).locator('[data-sheet="close"]').click();
  await toBoard(page);
  await page.locator('.icard', { hasText: '<img src=x' }).waitFor();
  ok(true, 'an admin can restore an archived issue');

  // ---- A second member, and admin setting his position -------------------------------------------------
  const two = await browser.newContext({ ...devices['iPhone 14'] });
  const p2 = await two.newPage();
  watch(p2, 'member');
  await p2.goto(BASE + '#board');
  await p2.locator('.icard').first().waitFor();
  ok(await p2.locator('.icard', { hasText: 'E2E Book venue' }).count() === 1, 'a visitor on another phone sees the board');
  await p2.locator('.icard', { hasText: 'E2E Book venue' }).click();
  const ro = sheet(p2);
  ok(await ro.locator('[name="title"]').count() === 0 && await ro.locator('a[href^="https://docs.google.com"][rel~="noopener"]').count() === 1, 'a visitor opens an issue read-only, with its document link');
  await shot(p2, 'phone-issue-visitor');
  await ro.locator('[data-sheet="close"]').click();
  await signIn(p2, 'member1.test@my.fit.edu', 9001);
  await p2.locator('.sheet-title', { hasText: 'Set up your profile' }).waitFor();
  await sheet(p2).locator('[name="name"]').fill('Blake Member');
  await sheet(p2).locator('[name="grad_year"]').fill('2028');
  await sheet(p2).locator('[data-sheet="primary"]').click();
  await p2.locator('#account .acct-btn').waitFor();
  await toSettings(p2);
  ok(await p2.locator('#scene-settings [data-go]').count() === 0 && /Blake Member/.test(await p2.locator('#scene-settings').innerText()), 'a regular member\'s Settings has his profile but no Manage section');

  await page.reload();
  await toSettings(page);
  await page.locator('#scene-settings [data-go="members"]').click();
  await sheet(page).locator('[data-member]', { hasText: 'Blake Member' }).click();
  await sheet(page).locator('label.check', { hasText: 'Rush Chairman' }).click();
  await sheet(page).locator('[data-sheet="primary"]').click();
  await sheet(page).locator('[data-member]', { hasText: 'Rush Chairman' }).waitFor();
  ok(true, 'the admin can give a member a position');
  await shot(page, 'phone-admin-members');

  await p2.reload();
  await toSettings(p2);
  ok(/Rush Chairman/.test(await p2.locator('#scene-settings').innerText()), 'the member sees his new position in Settings');
  await p2.locator('#scene-settings [data-set="edit"]').click();
  ok(await sheet(p2).locator('[name="name"]').inputValue() === 'Blake Member', 'Edit profile opens from Settings');
  await sheet(p2).locator('[data-sheet="close"]').click();
  await shot(p2, 'phone-account');

  // ---- Recruitment ------------------------------------------------------------------
  await closeSheets(page);
  await closeSheets(p2);
  ok(await page.locator('#gtab-recruit').isVisible(), 'recruitment: an admin sees the Recruit tab');
  ok(!(await p2.locator('#gtab-recruit').isVisible()), 'recruitment: a brother without access does not');
  await p2.goto(BASE + '#recruit');
  await p2.locator('#scene-recruit .app-note').waitFor();
  ok(/recruitment team/.test(await p2.locator('#scene-recruit').innerText()), 'recruitment: going to it directly says he has no access');

  // A PNM fills in the interest form on his phone.
  const pnmCtx = await browser.newContext({ ...devices['iPhone 14'] });
  const pf = await pnmCtx.newPage();
  watch(pf, 'interest form');
  await pf.goto(BASE.replace(/Dashboard\/$/, 'Interest/'));
  await pf.locator('#submit').click();
  ok(await pf.locator('.card.has-error').count() >= 9, 'interest form: sending it empty marks every required question');
  await pf.fill('#name', 'Riley Prospect'); await pf.fill('#phone', '(321) 555-0177'); await pf.fill('#email', 'riley.test@my.fit.edu');
  await pf.locator('label.choice', { hasText: 'Email' }).click();
  await pf.fill('#student_id', '12345');
  await pf.fill('#major', 'Mechanical Engineering'); await pf.fill('#hobbies', 'Sailing, intramural soccer');
  await pf.setInputFiles('#photo', { name: 'riley.png', mimeType: 'image/png', buffer: png });
  await pf.fill('#allergies', 'None'); await pf.fill('#met_by', 'Alex Admin');
  await pf.locator('#submit').click();
  ok(/900/.test(await pf.locator('#student_id-err').innerText()), 'interest form: a wrong 900 number is caught before sending');
  await pf.fill('#student_id', '900765432');
  await pf.locator('#submit').click();
  await pf.locator('#done').waitFor();
  ok(/Thanks, Riley!/.test(await pf.locator('#done').innerText()) && /by email/.test(await pf.locator('#done').innerText()), 'interest form: sends, and thanks him by name');
  await shot(pf, 'phone-interest-done');
  await pnmCtx.close();

  // The admin works him in the Recruitment tab.
  await closeSheets(page);
  await page.locator('#gtab-recruit').click();
  const riley = page.locator('.pcard', { hasText: 'Riley Prospect' });
  await riley.waitFor();
  ok(await riley.locator('img').count() === 1, 'recruitment: his form photo shows on his card');
  ok(/Interested/.test(await riley.innerText()) && /With Alex Admin/.test(await riley.innerText()), 'recruitment: he arrives as Interested, with the brother he named as main contact');
  await noSideScroll(page, 'Recruitment list');
  await shot(page, 'phone-recruit-list');
  await riley.click();
  const ps = sheet(page);
  await ps.locator('.profile-top').waitFor();
  ok(/900765432/.test(await ps.innerText()) && /Sailing/.test(await ps.innerText()), 'recruitment: his profile shows the form answers');
  ok(await ps.locator('a[href^="tel:"]').count() === 1 && await ps.locator('a[href^="sms:"]').count() === 1 && await ps.locator('a[href^="mailto:riley.test@my.fit.edu"]').count() === 1, 'recruitment: call, text and email buttons');
  await ps.locator('label.check', { hasText: 'In person' }).click();
  await ps.locator('[name="contact_note"]').fill('Met at the club fair');
  await ps.locator('[data-do="log"]').click();
  await page.waitForFunction(() => /logged a in person: “Met at the club fair”/.test(document.querySelector('.sheet-back:last-of-type .act')?.innerText || ''));
  ok(true, 'recruitment: logging a contact shows in his history with who did it');
  await ps.locator('[data-live="stage"]').selectOption('met');
  await page.waitForFunction(() => /moved him: Interested → Met/.test(document.querySelector('.sheet-back:last-of-type .act')?.innerText || ''));
  ok(true, 'recruitment: changing his stage is logged');
  await ps.locator('[data-live="main_contact"]').selectOption({ label: 'Blake Member' });
  await page.waitForFunction(() => /set the main contact to Blake Member/.test(document.querySelector('.sheet-back:last-of-type .act')?.innerText || ''));
  ok(true, 'recruitment: handing him to another brother is logged');
  await shot(page, 'phone-recruit-profile');
  await ps.locator('[data-sheet="close"]').click();

  await page.locator('[data-view="pipeline"]').click();
  ok(await page.locator('.rec-cols .col[data-stage="met"] .pmini', { hasText: 'Riley Prospect' }).count() === 1, 'recruitment: the pipeline shows him under Met');
  ok((await page.locator('.rec-cols .col-head').allInnerTexts()).map((t) => t.split('\n')[0]).join() === 'Interested,Contacted,Met,Invited,Bid,Accepted,Deferred,Did not accept', 'recruitment: the pipeline has your eight stages, in order');
  await shot(page, 'phone-recruit-pipeline');
  await page.locator('[data-view="numbers"]').click();
  ok(/Contacts logged, by brother/i.test(await page.locator('#scene-recruit').innerText()) && /Alex Admin/.test(await page.locator('#scene-recruit .num-grid').innerText()), 'recruitment: numbers show contacts by brother');
  await shot(page, 'phone-recruit-numbers');
  await page.locator('[data-view="people"]').click();
  await page.locator('[data-rec="qr"]').click();
  await sheet(page).locator('.qr svg').waitFor();
  ok(/Interest/.test(await sheet(page).locator('.qr-url').innerText()), 'recruitment: the QR button shows a code for the interest form');
  await shot(page, 'phone-recruit-qr');
  await sheet(page).locator('[data-sheet="close"]').click();

  // The admin lets Blake in.
  await toSettings(page);
  await page.locator('#scene-settings [data-go="members"]').click();
  await sheet(page).locator('[data-member]', { hasText: 'Blake Member' }).click();
  await sheet(page).locator('label.switch', { hasText: 'Recruitment access' }).locator('input').check();
  await sheet(page).locator('[data-sheet="primary"]').click();
  await sheet(page).locator('[data-member]', { hasText: 'Recruitment' }).waitFor();
  ok(true, 'admin turns on recruitment access for Blake');
  await sheet(page).locator('[data-sheet="close"]').click();
  await p2.reload();
  await p2.locator('#gtab-recruit').waitFor();
  await p2.locator('#gtab-recruit').click();
  await p2.locator('.pcard', { hasText: 'Riley Prospect' }).waitFor();
  ok(/With Blake Member/.test(await p2.locator('.pcard', { hasText: 'Riley Prospect' }).innerText()), 'Blake now sees Riley, assigned to him');
  await p2.locator('.pill[data-filter="mine"]').click();
  ok(await p2.locator('.pcard').count() === 1, 'the "Mine" filter shows only his PNMs');

  // ---- Quick access: org chart and study hours --------------------------------------
  // A visitor sees the org chart, and is asked to sign in for study hours.
  const vis = await (await browser.newContext({ ...devices['iPhone 14'] })).newPage();
  watch(vis, 'visitor quick');
  await vis.goto(BASE + '#quick');
  await vis.locator('#scene-quick [data-quick="org"]').waitFor();
  ok(await vis.locator('#gtab-quick').isVisible() && /Sign in/.test(await vis.locator('[data-quick="study"]').innerText()), 'quick access: a visitor sees the tab, and study hours asks him to sign in');
  await vis.locator('[data-quick="org"]').click();
  ok(/Prytanis/.test(await sheet(vis).locator('.oc-top').innerText()), 'org chart: the top position sits at the top');
  ok(await sheet(vis).locator('.oc-card', { hasText: 'Rush Chairman' }).locator('.oc-name', { hasText: 'Blake Member' }).count() === 1, 'org chart: shows who holds each position, from Settings');
  ok(!/Committee/.test(await sheet(vis).locator('.org').innerText()), 'org chart: committees are left off');
  await noSideScroll(vis, 'org chart');
  await shot(vis, 'phone-org-chart');
  await sheet(vis).locator('[data-sheet="close"]').click();
  await vis.locator('[data-quick="study"]').click();
  ok(await sheet(vis).locator('[name="scroll"]').count() === 1, 'study hours: a visitor is sent to sign in first');
  await sheet(vis).locator('[data-sheet="close"]').click();
  await vis.locator('#gtab-metrics').click();
  await vis.locator('#metrics-menu .menu-item').first().waitFor();
  ok(await vis.locator('#metrics-menu [data-scene="finance"]').count() === 0, 'finances: a visitor\'s Metrics menu has no Finances');
  await vis.keyboard.press('Escape');
  await vis.goto(BASE + '#finance');
  await vis.locator('#scene-finance .empty').waitFor();
  ok(/Sign in/.test(await vis.locator('#scene-finance').innerText()) && await vis.locator('#scene-finance .fin-line').count() === 0, 'finances: a visitor who opens the link is asked to sign in and sees no numbers');
  await vis.context().close();

  // Blake times a study session, closes the app, and logs it.
  await p2.locator('#gtab-quick').click();
  await p2.locator('[data-quick="study"]').click();
  await sheet(p2).locator('[data-st="start"]').click();
  await p2.reload();
  await p2.locator('#scene-quick .q-live').waitFor();
  ok(/Timer running/.test(await p2.locator('[data-quick="study"]').innerText()), 'study timer: keeps running after the app is closed and reopened');
  await p2.locator('[data-quick="study"]').click();
  await sheet(p2).locator('[data-st="stop"]').click();
  ok(Number(await sheet(p2).locator('[name="hours"]').inputValue()) > 0, 'study timer: stopping it fills in the hours');
  await sheet(p2).locator('[name="hours"]').fill('1.5');
  await sheet(p2).locator('[name="place"]').fill('Evans Library');
  await sheet(p2).locator('[data-sheet="primary"]').click();
  await sheet(p2).locator('.rowi', { hasText: '1.5 h' }).waitFor();
  ok(/1\.5 h/.test(await sheet(p2).locator('.st-totals').innerText()) && await sheet(p2).locator('[data-st="start"]').count() === 1, 'study hours: saving logs it, adds it to his totals and clears the timer');
  await sheet(p2).locator('[name="hours"]').fill('30');
  await sheet(p2).locator('[data-sheet="primary"]').click();
  ok(/hours you studied/.test(await sheet(p2).locator('.form-error').innerText()), 'study hours: more than 24 in one go is caught');
  ok(await sheet(p2).locator('.st-chapter').count() === 0, 'study hours: a regular brother sees only his own');
  await shot(p2, 'phone-study-hours');
  await sheet(p2).locator('[data-sheet="close"]').click();

  // ---- Finances: the budget, for every signed-in brother --------------------------
  await admin.from('budget_lines').upsert([
    { name: 'E2E Rush', budgeted: 100, spent: 130, sort: 901 },
    { name: 'E2E Social', budgeted: 200, spent: 50, sort: 902 },
    { name: 'E2E Composite', budgeted: 0, spent: 25, sort: 903 },
  ]);
  await admin.from('budget_sync').upsert({ id: true, synced_at: new Date().toISOString(), tried_at: new Date().toISOString(), problem: null });
  await p2.locator('#gtab-metrics').click();
  ok(/Board\s*Finances/.test(await p2.locator('#metrics-menu').innerText()), 'finances: a signed-in brother finds it in the Metrics menu, after Board');
  await p2.locator('#metrics-menu [data-scene="finance"]').click();
  ok(/Finances/.test(await p2.locator('#gtab-metrics').innerText()) || await p2.locator('#scene-finance').isVisible(), 'finances: opens from the menu');
  const rush = p2.locator('#scene-finance .fin-line', { hasText: 'E2E Rush' });
  await rush.waitFor();
  ok(/Over by \$30\.00/.test(await rush.innerText()) && await rush.locator('.fin-mark').count() === 1, 'finances: a line past its budget says by how much and marks the budget');
  ok(/\$150\.00 left/.test(await p2.locator('#scene-finance .fin-line', { hasText: 'E2E Social' }).innerText()), 'finances: a line under budget shows what is left');
  ok(/Not budgeted/.test(await p2.locator('#scene-finance .fin-line', { hasText: 'E2E Composite' }).innerText()), 'finances: spending on a line with no budget is flagged');
  ok(await p2.locator('#scene-finance .fin-split').count() === 2 && await p2.locator('#scene-finance .fin-legend li').count() >= 2, 'finances: both splits draw, each with a legend');
  ok(/updated just now|updated \d+ min ago/.test(await p2.locator('#scene-finance .fin-updated').innerText()), 'finances: says when the Sheet was last read');
  await p2.locator('#scene-finance .fin-seg').first().click();
  ok(await p2.locator('#scene-finance .fin-tip').isVisible(), 'finances: tapping a part of a split shows its name and amount');
  await noSideScroll(p2, 'finances');
  await shot(p2, 'phone-finances');
  await admin.from('budget_sync').upsert({ id: true, tried_at: new Date(Date.now() + 1000).toISOString(), problem: 'test problem' });
  await p2.reload();
  await metrics(p2, 'finance');
  await p2.locator('#scene-finance .fin-notice').waitFor();
  ok(/couldn't be read/.test(await p2.locator('#scene-finance .fin-notice').innerText()) && await p2.locator('#scene-finance .fin-line', { hasText: 'E2E Rush' }).count() === 1, 'finances: when the Sheet can\'t be read it says so and keeps the last numbers');
  ok(!/test problem/.test(await p2.locator('#scene-finance .fin-notice').innerText()), 'finances: a regular brother doesn\'t see the technical reason');
  await admin.from('budget_sync').upsert({ id: true, tried_at: new Date().toISOString(), synced_at: new Date().toISOString(), problem: null });
  await admin.from('budget_lines').delete().like('name', 'E2E%');
  await p2.locator('#gtab-quick').click();
  await p2.locator('[data-quick="study"]', { hasText: 'This week 1.5 h' }).waitFor({ timeout: 8000 }).catch(() => {});
  ok(/This week 1\.5 h/.test(await p2.locator('[data-quick="study"]').innerText()), 'quick access: the tile shows his week');
  await noSideScroll(p2, 'Quick access');

  // The admin sees the whole chapter, and can move a position on the chart.
  await page.locator('#gtab-quick').click();
  await page.locator('[data-quick="study"]').click();
  await sheet(page).locator('.st-chapter').waitFor();
  ok(/Blake Member[\s\S]*1\.5 h/.test(await sheet(page).locator('.st-chapter').innerText()), 'study hours: an admin sees every brother\'s hours');
  await shot(page, 'phone-study-admin');
  await closeSheets(page);
  await toSettings(page);
  await page.locator('#scene-settings [data-go="teams"]').click();
  await sheet(page).locator('.rowi', { hasText: 'Rush Chairman' }).locator('[data-edit]').click();
  await sheet(page).locator('[name="chart"]').selectOption('exec');
  await sheet(page).locator('[data-sheet="primary"]').click();
  await sheet(page).locator('.rowi', { hasText: 'Rush Chairman' }).filter({ hasText: 'Executive board' }).waitFor();
  await closeSheets(page);
  // A link straight to the org chart opens it.
  await page.goto('about:blank');
  await page.goto(BASE + '#quick/org');
  await sheet(page).locator('.org').waitFor();
  ok(await sheet(page).locator('.oc-tier', { hasText: 'Executive board' }).locator('.oc-card', { hasText: 'Rush Chairman' }).count() === 1, 'org chart: an admin can move a position to the executive board');
  await closeSheets(page);
  await toSettings(page);
  await page.locator('#scene-settings [data-go="teams"]').click();
  await sheet(page).locator('.rowi', { hasText: 'Rush Chairman' }).locator('[data-edit]').click();
  await sheet(page).locator('[name="chart"]').selectOption('chair');
  await sheet(page).locator('[data-sheet="primary"]').click();
  await sheet(page).locator('.rowi', { hasText: 'Rush Chairman' }).filter({ hasText: 'Chairmen' }).waitFor();
  await closeSheets(page);

  // ---- Event check-in -----------------------------------------------------------------
  // The admin (an officer) starts check-in on an event happening now; a new brother
  // checks in from Quick access with the code, first from too far away, then from the house.
  const HOUSE = { latitude: 28.0653, longitude: -80.6236 }, NEAR = { latitude: 28.06565, longitude: -80.62375 }, FAR = { latitude: 28.0753, longitude: -80.6236 };
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  await admin.from('events').insert({ id: `E2E-checkin|${at(-10 * 60e3)}`, title: 'E2E Chapter meeting', starts_at: at(-10 * 60e3), ends_at: at(50 * 60e3), location: 'Chapter house' });
  await phone.grantPermissions(['geolocation']);
  await phone.setGeolocation(HOUSE);
  await page.goto('about:blank');
  await page.goto(BASE + '#week');
  await page.locator('#account .acct-btn').waitFor();
  await page.locator('#scene-week .ev', { hasText: 'E2E Chapter meeting' }).first().click();
  await page.locator('#event-pop [data-ci="start"]').click();
  ok(await sheet(page).locator('[name="need_location"]').isChecked(), 'check-in: Must be here is on by default');
  await sheet(page).locator('[data-sheet="primary"]').click();
  await sheet(page).locator('.ci-code').waitFor();
  const ciCode = (await sheet(page).locator('.ci-code').innerText()).trim();
  ok(/^[A-Z0-9]{4}$/.test(ciCode), `check-in: the officer gets a 4-character code (${ciCode})`);
  await shot(page, 'phone-checkin-code');
  ok(await page.locator('#week-extra [data-ci="past"]').count() === 1, 'check-in: officers get a Past events button on This week');

  const bro = await (await browser.newContext({ ...devices['iPhone 14'], geolocation: FAR, permissions: ['geolocation'] })).newPage();
  watch(bro, 'brother');
  await bro.goto(BASE + '#quick');
  await signIn(bro, 'checkin.test@my.fit.edu', 9005);
  await bro.locator('.sheet-title', { hasText: 'Set up your profile' }).waitFor();
  await sheet(bro).locator('[name="grad_year"]').fill('2029');
  await sheet(bro).locator('[data-sheet="primary"]').click();
  await bro.locator('#account .acct-btn').waitFor();
  await bro.locator('#gtab-week').click();
  await bro.locator('#gtab-quick').click();
  await bro.locator('[data-quick="checkin"] .q-live').waitFor();
  ok(/Check-in open · E2E Chapter meeting/.test(await bro.locator('[data-quick="checkin"]').innerText()), 'check-in: the brother\'s Quick tile says check-in is open');
  ok(await bro.locator('#week-extra [data-ci="past"]').count() === 0, 'check-in: a brother with no position gets no Past events button');
  await bro.locator('[data-quick="checkin"]').click();
  await sheet(bro).locator('[data-ci="here"]').waitFor();
  ok(/E2E Chapter meeting/.test(await sheet(bro).locator('.ci-here').innerText()), 'check-in: the screen offers Check in here for the open event');
  await bro.waitForTimeout(400);
  await shot(bro, 'phone-checkin-here');
  await sheet(bro).locator('[name="code"]').fill(ciCode.toLowerCase());
  await sheet(bro).locator('[data-ci="go"]').click();
  await sheet(bro).locator('.form-error:not(:empty)').waitFor();
  ok(/m from where check-in was started/.test(await sheet(bro).locator('.form-error').innerText()), 'check-in: from 1 km away, even with the code, he is told he is too far');
  await sheet(bro).locator('[name="code"]').fill('');
  await bro.context().setGeolocation(NEAR);
  await sheet(bro).locator('[data-ci="here"]').click();
  await sheet(bro).locator('.ci-success').waitFor();
  ok(/You're checked in/.test(await sheet(bro).locator('.ci-success').innerText()), 'check-in: from 40 m away he taps Check in here, with no code, and is checked in');
  await shot(bro, 'phone-checkin-done');
  await sheet(bro).locator('.ci-success [data-sheet="close"]').click(); // Done
  await bro.locator('#gtab-week').click();
  await bro.locator('#scene-week .ev', { hasText: 'E2E Chapter meeting' }).first().click();
  await bro.locator('#event-pop .ci-done').waitFor();
  ok(/You checked in at/.test(await bro.locator('#event-pop .ci-box').innerText()), 'check-in: the event details tell him he checked in');

  await page.waitForFunction(() => /\b1\b/.test(document.querySelector('.sheet-back:last-of-type .ci-count')?.innerText || ''), null, { timeout: 12000 });
  ok(true, 'check-in: the officer\'s count goes up by itself');
  await sheet(page).locator('[data-ci="attendance"]').click();
  await sheet(page).locator('.ci-count').waitFor();
  ok(/1 of \d+ brothers/.test(await sheet(page).locator('.ci-count').innerText()), 'attendance: shows how many of the chapter checked in');
  ok(/at the event/.test(await sheet(page).locator('.rowi', { hasText: 'E2E' }).first().innerText().catch(() => '')) || /at the event/.test(await sheet(page).innerText()), 'attendance: shows he checked in at the event, not with the code');
  await sheet(page).locator('.rowi', { hasText: 'Blake Member' }).locator('[data-add]').click();
  await sheet(page).locator('.rowi', { hasText: 'added by' }).waitFor();
  ok(/Blake Member[\s\S]*added by/.test(await sheet(page).locator('.fsec', { has: page.locator('h3', { hasText: /^Checked in$/ }) }).innerText()) && !/Former member/.test(await sheet(page).innerText()), 'attendance: an officer adds a brother by hand, and it says who added him');
  const dl = page.waitForEvent('download');
  await sheet(page).locator('[data-csv]').click();
  const file = await dl;
  ok(/^E2E-Chapter-meeting-\d{4}-\d{2}-\d{2}\.csv$/.test(file.suggestedFilename()), `attendance: downloads as a spreadsheet (${file.suggestedFilename()})`);
  await closeSheets(page);
  await page.locator('#gtab-week').click();
  await page.locator('#week-extra [data-ci="past"]').click();
  await sheet(page).locator('.rowi', { hasText: 'E2E Chapter meeting' }).waitFor();
  ok(/2 checked in/.test(await sheet(page).locator('.rowi', { hasText: 'E2E Chapter meeting' }).innerText()), 'past events: lists the event with its attendance');
  await shot(page, 'phone-past-events');
  await closeSheets(page);

  await cleanup(); // leave no open check-in behind for the other test scripts
  await browser.close();
  ok(errors.length === 0, 'no script errors in any browser', errors.join('\n        '));
  console.log(`\n${passed}/${passed + failed} app checks passed. Screenshots in sync/.shots/app/`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); console.log(`\nstopped after ${passed} passed, ${failed} failed`); if (errors.length) console.log(errors.join('\n')); process.exit(1); });
