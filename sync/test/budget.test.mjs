// The budget Sheet reader. Made-up numbers: the repo is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { money, parseBudget, parseCsv, BudgetFormatError } from '../lib/budget.mjs';

// Shaped like Google Sheets' "Publish to web" CSV of the budget tab: a title
// row, the table off to the side, currency text, then other blocks below.
const SHEET = [
  'Fall budget,,,,,',
  ',,,,,',
  ',Chapter Expenses,Budgeted,Amount Spent,Remaining Budget,',
  ',Rush,$400.00,$512.30,-$112.30,',
  ',Social,$150.00,$20.00,$130.00,',
  ',"T-Shirts / Jerseys","$1,100.00","$1,050.25",$49.75,',
  ',Composite,$0.00,$99.99,-$99.99,',
  ',Debt,$0.00,$0.00,$0.00,',
  ',,,,,',
  ',Income,Expected,Collected,,',
  ',Dues,"$9,000.00","$7,000.00",,',
].join('\r\n');

test('reads only the Chapter Expenses table', () => {
  const lines = parseBudget(SHEET);
  assert.deepEqual(lines.map((l) => l.name), ['Rush', 'Social', 'T-Shirts / Jerseys', 'Composite', 'Debt']);
  assert.deepEqual(lines[2], { name: 'T-Shirts / Jerseys', budgeted: 1100, spent: 1050.25, sort: 3 });
  assert.equal(lines[0].spent, 512.3);
  assert.ok(!lines.some((l) => /dues|income/i.test(l.name)), 'stops at the blank row: income is never read');
});

test('stops at a Total row', () => {
  const lines = parseBudget('Chapter Expenses,Budgeted,Amount Spent\nRush,10,5\nTotal,10,5\nSecret,1,1\n');
  assert.deepEqual(lines.map((l) => l.name), ['Rush']);
});

test('money formats', () => {
  assert.equal(money('$1,300.00'), 1300);
  assert.equal(money('-$109.14'), -109.14);
  assert.equal(money('$-109.14'), -109.14);
  assert.equal(money('($30.45)'), -30.45);
  assert.equal(money(' 250 '), 250);
  assert.equal(money(''), 0);
  assert.equal(money('$ -'), 0);
  assert.equal(money('#REF!'), null);
  assert.equal(money('abc'), null);
});

test('CSV quoting', () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""e"""\n'), [['a', 'b, c', 'd "e"']]);
  assert.deepEqual(parseCsv('﻿x,y'), [['x', 'y']]);
});

test('refuses a Sheet it cannot read safely', () => {
  assert.throws(() => parseBudget('Name,Cost\nRush,5'), BudgetFormatError, 'no header');
  assert.throws(() => parseBudget('Chapter Expenses,Budgeted,Amount Spent\n\nRush,1,1'), BudgetFormatError, 'no lines');
  assert.throws(() => parseBudget('Chapter Expenses,Budgeted,Amount Spent\nRush,#REF!,1'), BudgetFormatError, 'broken formula');
  assert.throws(() => parseBudget('Chapter Expenses,Budgeted,Amount Spent\nRush,1,1\nrush,2,2'), BudgetFormatError, 'duplicate line');
});

// ---- Reading the Sheet as a robot (Google service account) --------------------------
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { readKey, sheetFromUrl, signedAssertion, sheetRows } from '../lib/google.mjs';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = JSON.stringify({ type: 'service_account', client_email: 'budget-robot@demo-project.iam.gserviceaccount.com', private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' });
const SHEET_LINK = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=777';

test('finds the Sheet and the tab in its link', () => {
  assert.deepEqual(sheetFromUrl(SHEET_LINK), { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', gid: 777 });
  assert.equal(sheetFromUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit').gid, null);
  assert.throws(() => sheetFromUrl('https://example.com/x'), /link to the Google Sheet/);
});

test('refuses a key that is not a service account', () => {
  assert.throws(() => readKey('not json'), /not valid JSON/);
  assert.throws(() => readKey('{"type":"authorized_user"}'), /not a service account/);
});

test('signs a read-only token request the key can verify', () => {
  const [h, c, sig] = signedAssertion(readKey(KEY), 1_000_000).split('.');
  const claim = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claim.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.equal(claim.exp - claim.iat, 3600);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(pair.publicKey, Buffer.from(sig, 'base64url')));
});

test('reads the tab named by the link, numbers as numbers', async () => {
  const calls = [];
  const fake = async (url, opts = {}) => {
    calls.push(String(url));
    const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
    if (/oauth2/.test(url)) return json({ access_token: 'tok' });
    assert.equal(opts.headers.Authorization, 'Bearer tok');
    if (/fields=sheets/.test(url)) return json({ sheets: [{ properties: { sheetId: 0, title: 'Dues' } }, { properties: { sheetId: 777, title: "Fall '26 Budget" } }] });
    if (/\/values\//.test(url)) return json({ values: [['Chapter Expenses', 'Budgeted', 'Amount Spent'], ['Rush', 400, 512.3], ['Formal', 1500, 0], [], ['Dues', 9000, 7000]] });
    return json({}, 404);
  };
  const rows = await sheetRows(SHEET_LINK, KEY, fake);
  assert.ok(calls.some((u) => u.includes(encodeURIComponent("'Fall ''26 Budget'"))), 'reads the tab whose gid is in the link, quoting its name');
  assert.ok(!calls.some((u) => u.includes('Dues')), 'never asks for another tab');
  assert.deepEqual(parseBudget(rows), [
    { name: 'Rush', budgeted: 400, spent: 512.3, sort: 1 },
    { name: 'Formal', budgeted: 1500, spent: 0, sort: 2 },
  ]);
});

test('a Sheet not shared with the robot says how to fix it', async () => {
  const fake = async (url) => ({ ok: /oauth2/.test(url), status: /oauth2/.test(url) ? 200 : 403, json: async () => (/oauth2/.test(url) ? { access_token: 't' } : { error: { message: 'The caller does not have permission' } }) });
  await assert.rejects(sheetRows(SHEET_LINK, KEY, fake), /shared with the robot's email as a Viewer/);
});
