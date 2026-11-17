// The Treasurer's budget Sheet -> budget lines. The rows come from the Sheets
// API (lib/google.mjs) or, for local testing, a CSV export of the tab.
//
// Only the "Chapter Expenses" table is read: the row whose cells include
// "Budgeted" and "Amount Spent" is the header, the column above the line names
// is the one headed "Chapter Expenses" (or the first column), and the lines run
// down from there until a blank row or a "Total" row. Anything else in the CSV
// is ignored. "Remaining Budget" isn't read; the app works it out.

// RFC 4180: quoted fields may hold commas, quotes ("") and line breaks.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// 1300, "$1,300.00", "-$109.14", "($109.14)", "1300", "" -> a number (blank = 0).
// Anything else (text, an error like #REF!) -> null.
export function money(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  let t = String(v ?? '').trim();
  if (t === '' || t === '-' || t === '$-' || t === '$ -') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1).trim(); }
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1).trim(); }
  t = t.replace(/^\$\s*/, '').replace(/,/g, '');
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Math.round(Number(t) * 100) / 100;
  return neg ? -n : n;
}

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export class BudgetFormatError extends Error {}

/** CSV text, or rows of cells from the Sheets API -> budget lines. */
export function parseBudget(input) {
  const rows = typeof input === 'string' ? parseCsv(input) : input;
  let head = -1, cName = -1, cBudget = -1, cSpent = -1;
  for (let r = 0; r < rows.length && head < 0; r++) {
    const cells = rows[r].map(norm);
    const b = cells.findIndex((c) => c === 'budgeted' || c === 'budget');
    const s = cells.findIndex((c) => c === 'amount spent' || c === 'spent');
    if (b < 0 || s < 0) continue;
    head = r; cBudget = b; cSpent = s;
    cName = cells.findIndex((c) => c === 'chapter expenses');
    if (cName < 0) cName = cells.findIndex((c, i) => c !== '' && i < b);
    if (cName < 0) cName = 0;
  }
  if (head < 0) throw new BudgetFormatError('No "Budgeted" and "Amount Spent" header row in the Sheet.');

  const lines = [];
  const seen = new Set();
  for (let r = head + 1; r < rows.length; r++) {
    const name = String(rows[r][cName] ?? '').trim().replace(/\s+/g, ' ');
    if (!name || /^total\b/i.test(name)) break;
    const budgeted = money(rows[r][cBudget]);
    const spent = money(rows[r][cSpent]);
    if (budgeted == null || spent == null) throw new BudgetFormatError(`Row ${r + 1} ("${name.slice(0, 40)}") has an amount that isn't a number.`);
    if (name.length > 80) throw new BudgetFormatError(`Row ${r + 1} has a name longer than 80 characters.`);
    if (seen.has(name.toLowerCase())) throw new BudgetFormatError(`"${name.slice(0, 40)}" appears twice.`);
    seen.add(name.toLowerCase());
    lines.push({ name, budgeted, spent, sort: lines.length + 1 });
  }
  if (!lines.length) throw new BudgetFormatError('The Chapter Expenses table has no lines under its header.');
  if (lines.length > 60) throw new BudgetFormatError('More than 60 budget lines; is the right tab published?');
  return lines;
}
