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
  await admin.from('teams').delete().like('name', 'E2E%');
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
// Phone navigation: three bottom tabs; Goals and Board share the Goals tab behind a switch.
const toGoals = async (page) => { await page.locator('#gtab-goals').click(); await page.locator('.subtab[data-scene="goals"]').click(); };
const toBoard = async (page) => { await page.locator('#gtab-goals').click(); await page.locator('.subtab[data-scene="board"]').click(); };
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
  ok((await page.locator('#gtabs .gtab:visible').allInnerTexts()).map((t) => t.trim()).join() === 'KRA,This week,Goals', 'phone: three bottom tabs for a visitor: KRA, This week, Goals');
  ok(await page.locator('#gtabs').evaluate((el) => getComputedStyle(el).position === 'fixed' && el.getBoundingClientRect().bottom >= innerHeight - 1), 'phone: the tabs are a bar fixed to the bottom');
  ok(await page.locator('.gtab svg').first().isVisible() && !(await page.locator('#tabs').isVisible()), 'phone: tabs have icons, and the desktop tab row is hidden');
  ok((await page.locator('#subtabs .subtab').allInnerTexts()).join() === 'Goals,Board' && await page.locator('#gtab-goals').getAttribute('aria-selected') === 'true', 'phone: the Goals tab has a Goals | Board switch');
  await page.locator('#gtab-kra').click();
  ok(await page.locator('#scene-kras').isVisible() && await page.locator('#scene-required').isVisible() && await page.locator('#subtabs .subtab').count() === 0, 'phone: the KRA tab shows the scoreboard with required & bonus under it');
  ok(await page.evaluate(() => document.getElementById('scene-required').getBoundingClientRect().top > document.getElementById('scene-kras').getBoundingClientRect().bottom - 1), 'phone: required & bonus sits below the scoreboard');
  await noSideScroll(page, 'KRA tab');
  await shot(page, 'phone-kra-tab');
  await page.locator('#gtab-week').click();
  await page.locator('#gtab-kra').click();
  ok(await page.locator('#ranks-m .rk').isVisible(), 'phone: rankings show in the KRA tab');
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
  await page.locator('#gtab-goals').click();
  ok(await page.locator('#scene-goals').isVisible(), 'phone: the Goals tab reopens on the screen you left it on');
  ok(!(await page.locator('#ranks-m').isVisible()), 'phone: no rankings on Goals');
  ok(await page.locator('#account [data-act="signin"]').isVisible(), 'visitor sees a Sign in button');
  ok(await page.locator('#scene-goals .app-head h2').innerText() === 'Goals' && await page.locator('#scene-goals .goal-list, #scene-goals .app-note').count() === 1, 'visitor sees the goals list (or the empty note)');
  await noSideScroll(page, 'goals (visitor)');
  await page.locator('.subtab[data-scene="board"]').click();
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
  ok(await dp.locator('#ranks-m .rk').isVisible(), 'desktop: rankings still show on every screen');
  ok(await dp.locator('#tabs .tab:not(.needs-recruit)').count() === 5 && await dp.locator('#tabs').evaluate((el) => getComputedStyle(el).position !== 'fixed') && !(await dp.locator('#gtabs').isVisible()), 'desktop: five tabs across the top, no bottom bar');
  await dcard.scrollIntoViewIfNeeded();
  const from = await dcard.boundingBox(), to = await dp.locator('.col[aria-label="Done"] .col-list').boundingBox();
  await dp.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await dp.mouse.down();
  await dp.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  await dp.mouse.move(to.x + to.width / 2, to.y + 24, { steps: 14 });
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

  await browser.close();
  ok(errors.length === 0, 'no script errors in any browser', errors.join('\n        '));
  console.log(`\n${passed}/${passed + failed} app checks passed. Screenshots in sync/.shots/app/`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); console.log(`\nstopped after ${passed} passed, ${failed} failed`); if (errors.length) console.log(errors.join('\n')); process.exit(1); });
