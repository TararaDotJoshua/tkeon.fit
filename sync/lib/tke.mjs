// Log in to the TKE national module with a real headless browser and pull the
// raw KRA tables. Parsing lives in kra.mjs.
//
// If the site shows a CAPTCHA, asks for a verification code, or rate-limits us,
// we stop and report. We never try to get around a site protection.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { extractTablesInPage } from './kra.mjs';

export class StopError extends Error {} // a protection we must not get past

const CAPTCHA_FRAMES = /recaptcha\/api2\/(anchor|bframe)|hcaptcha\.com\/captcha|challenges\.cloudflare\.com/;
const CAPTCHA_TEXT = /verify (that )?you('re| are) (a )?human|are you a robot|complete the captcha|security check to continue/i;
const MFA_INPUTS = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="totp" i], input[name*="mfa" i], input[name*="2fa" i]';
const MFA_TEXT = /verification code|two[- ]factor|2-step|multi[- ]factor|one[- ]time (pass)?code|authenticator app|enter the code (we|that was) sent/i;

const noQuery = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return '(unknown url)'; } };

async function visible(frame, selector) {
  for (const loc of await frame.locator(selector).all().catch(() => [])) {
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

/** Throws StopError if the page is asking for a CAPTCHA or a verification code. */
async function assertNoChallenge(page, where) {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (CAPTCHA_FRAMES.test(url) && !/size=invisible/.test(url)) {
      const el = await frame.frameElement().catch(() => null);
      if (!el || (await el.isVisible().catch(() => true))) {
        throw new StopError(`The TKE site showed a CAPTCHA on the ${where}. Stopped; the sync will not try to get past it.`);
      }
    }
  }
  const body = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  if (CAPTCHA_TEXT.test(body)) {
    throw new StopError(`The TKE site asked to verify a human on the ${where}. Stopped; the sync will not try to get past it.`);
  }
  for (const frame of page.frames()) {
    const codeInput = await visible(frame, MFA_INPUTS);
    const password = await visible(frame, 'input[type=password]');
    if (codeInput || (!password && MFA_TEXT.test(body) && (await visible(frame, 'input[type=text], input[type=tel], input[type=number], input:not([type])')))) {
      throw new StopError(`The TKE site asked for a verification code (MFA) on the ${where}. Stopped; the owner needs to sort out MFA for this account.`);
    }
  }
}

async function findLoginFrame(page, sel) {
  for (const frame of page.frames()) {
    if (await visible(frame, sel.password)) return frame;
  }
  return null;
}

async function logIn(page, cfg, creds) {
  const sel = cfg.selectors;
  let frame = await findLoginFrame(page, sel);

  // Two-step logins show the username first and the password on the next screen.
  if (!frame) {
    const userOnly = await (async () => { for (const f of page.frames()) { const u = await visible(f, sel.username); if (u) return { f, u }; } return null; })();
    if (!userOnly) return false;
    await userOnly.u.fill(creds.username);
    const next = await visible(userOnly.f, sel.submit);
    if (next) await next.click(); else await userOnly.u.press('Enter');
    await page.waitForSelector(sel.password, { state: 'visible', timeout: 20_000 }).catch(() => {});
    await assertNoChallenge(page, 'login page');
    frame = await findLoginFrame(page, sel);
    if (!frame) throw new Error(`No password field after entering the username at ${noQuery(page.url())}. Check selectors.password in tke.config.json.`);
  } else {
    const user = await visible(frame, sel.username);
    if (!user) throw new Error(`Found a password field but no username field at ${noQuery(page.url())}. Check selectors.username in tke.config.json.`);
    await user.fill(creds.username);
  }

  const pw = await visible(frame, sel.password);
  await pw.fill(creds.password);
  const submit = await visible(frame, sel.submit);
  const nav = page.waitForNavigation({ timeout: 30_000 }).catch(() => null);
  if (submit) await submit.click(); else await pw.press('Enter');
  const res = await nav;
  if (res && res.status() === 429) throw new StopError('The TKE site rate-limited the login (HTTP 429). Stopped; try again later.');
  await settle(page);
  await assertNoChallenge(page, 'page after login');
  // Don't retry a rejected login: repeated bad attempts can lock the account.
  if (await findLoginFrame(page, sel)) {
    throw new Error('Login didn\'t go through (still on the login form). Check TKE_USERNAME / TKE_PASSWORD, or the login selectors.');
  }
  return true;
}

async function countKraTables(page) {
  let n = 0;
  for (const frame of page.frames()) {
    n += await frame.evaluate(() => [...document.querySelectorAll('table')].filter((t) => !t.querySelector('table') && [...t.rows].some((r) => {
      const cells = [...r.cells].map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim());
      return cells.some((x) => x.length < 40 && /\bkra\b/i.test(x)) && cells.some((x) => /result|goal|points/i.test(x));
    })).length).catch(() => 0);
  }
  return n;
}

/** Wait for KRA tables (they may be drawn by JavaScript), then until the row count stops changing. */
async function waitForKraTables(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const rows = await rowCount(page);
    const tables = await countKraTables(page);
    if (tables > 0) {
      if (rows === last) { if (Date.now() - stableSince > 2_000) return; } else { last = rows; stableSince = Date.now(); }
    }
    await page.waitForTimeout(500);
  }
  if (last < 0) throw new Error(`No table with a "KRA" header appeared within ${Math.round(timeoutMs / 1000)} s at ${noQuery(page.url())}. Check kraUrl, or the table detection.`);
}

async function rowCount(page) {
  let n = 0;
  for (const frame of page.frames()) n += await frame.evaluate(() => document.querySelectorAll('table tr').length).catch(() => 0);
  return n;
}

/**
 * @returns {Promise<Array>} raw tables for parseKraTables()
 */
export async function scrapeTke({ config, username, password, debugDir, log = console.log }) {
  if (!config.loginUrl || !config.kraUrl || /FILL_ME/.test(config.loginUrl + config.kraUrl)) {
    throw new Error('loginUrl and kraUrl are not set in sync/tke.config.json yet.');
  }
  if (!username || !password) throw new Error('TKE_USERNAME or TKE_PASSWORD is not set.');

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US', timezoneId: 'America/New_York' });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    log(`TKE: opening login page ${noQuery(config.loginUrl)}`);
    const first = await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (first?.status() === 429) throw new StopError('The TKE site rate-limited us (HTTP 429). Stopped; try again later.');
    await settle(page);
    await assertNoChallenge(page, 'login page');
    if (await logIn(page, config, { username, password })) log('TKE: submitted login');

    // Portals often land on a home page or bounce through login again with a
    // return URL. Try the KRA page, and log in once more if we were sent back.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await page.goto(config.kraUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (res?.status() === 429) throw new StopError('The TKE site rate-limited us (HTTP 429). Stopped; try again later.');
      await settle(page);
      await assertNoChallenge(page, 'KRA page');
      if (!(await findLoginFrame(page, config.selectors))) break;
      if (attempt === 2) throw new Error('Still on the login page after signing in. Check TKE_USERNAME / TKE_PASSWORD, or the login selectors.');
      log('TKE: sent back to login; signing in again');
      await logIn(page, config, { username, password });
    }

    log(`TKE: waiting for KRA tables at ${noQuery(page.url())}`);
    await waitForKraTables(page, (config.waitForTableSeconds ?? 45) * 1000);
    const tables = [];
    for (const frame of page.frames()) tables.push(...(await frame.evaluate(extractTablesInPage).catch(() => [])));
    log(`TKE: found ${tables.length} KRA table(s)`);
    return tables;
  } catch (err) {
    if (debugDir) {
      await mkdir(debugDir, { recursive: true }).catch(() => {});
      await page.screenshot({ path: path.join(debugDir, 'tke-debug.png'), fullPage: true }).catch(() => {});
      log(`TKE: saved debug screenshot (${noQuery(page.url())})`);
    }
    throw err;
  } finally {
    await browser.close();
  }
}

/** Parse a saved copy of the KRA page (for testing without logging in). */
export async function scrapeFile(file) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(new URL(`file://${path.resolve(file)}`).href);
    await waitForKraTables(page, 15_000);
    return await page.evaluate(extractTablesInPage);
  } finally {
    await browser.close();
  }
}
