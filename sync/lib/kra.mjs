// TKE KRA page -> rows for public.kras.
//
// Two halves:
//   extractTablesInPage()  runs inside the browser and returns raw cell data for
//                          every table that has a "KRA" header row.
//   parseKraTables(raw)    pure Node code that turns that into rows; unit-tested.

/**
 * Runs in the page (passed to frame.evaluate), so it must be self-contained.
 * Returns [{heading, headers, rows: [[cell]]}] where cell =
 * {text, colspan, hints, colors} and hints is lowercased class/src/alt/title text.
 */
export function extractTablesInPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isKraHeader = (row) => {
    const cells = [...row.cells].map((c) => clean(c.textContent));
    return cells.some((t) => t.length < 40 && /\bkra\b/i.test(t))
      && cells.some((t) => /result|goal|points/i.test(t));
  };
  const SECTION_WORDS = /key result|\bkras?\b|required|annual|bonus/i;

  function headingAbove(table) {
    if (table.caption && clean(table.caption.textContent)) return clean(table.caption.textContent);
    const seen = [];
    let node = table;
    for (let depth = 0; node && depth < 6 && seen.length < 8; depth++) {
      for (let sib = node.previousElementSibling; sib && seen.length < 8; sib = sib.previousElementSibling) {
        if (sib.matches('table') || sib.querySelector('table')) { seen.push(''); break; }
        const t = clean(sib.innerText || sib.textContent);
        if (t && t.length <= 120) seen.push(t);
      }
      if (seen.some((t) => SECTION_WORDS.test(t))) break;
      node = node.parentElement;
    }
    return seen.find((t) => SECTION_WORDS.test(t)) || seen.find(Boolean) || '';
  }

  function cellInfo(cell) {
    const els = [cell, ...cell.querySelectorAll('*')];
    const hints = [];
    const colors = [];
    for (const el of els) {
      hints.push(el.className && typeof el.className === 'string' ? el.className : '');
      for (const attr of ['src', 'alt', 'title', 'aria-label', 'data-status', 'fill']) {
        const v = el.getAttribute && el.getAttribute(attr);
        if (v) hints.push(v.startsWith('data:') ? '' : v);
      }
      const cs = getComputedStyle(el);
      for (const v of [cs.backgroundColor, cs.fill, cs.borderTopColor]) {
        if (v && !/rgba\(0, 0, 0, 0\)|transparent|none/.test(v)) colors.push(v);
      }
      // A dot drawn as a text glyph or an icon font: its color is the signal.
      const own = clean(el.textContent);
      if (/^[●•◉⬤○]$/.test(own) || (!own && /dot|circle|status|indicator|icon|fa-/i.test(String(el.className)))) colors.push(cs.color);
    }
    return {
      text: clean(cell.innerText || cell.textContent),
      colspan: cell.colSpan || 1,
      hints: hints.join(' ').toLowerCase().slice(0, 600),
      colors: colors.slice(0, 12),
    };
  }

  const out = [];
  for (const table of document.querySelectorAll('table')) {
    if (table.querySelector('table')) continue; // layout table wrapping the real ones
    const rows = [...table.rows];
    const headerIdx = rows.findIndex(isKraHeader);
    if (headerIdx < 0) continue;
    out.push({
      heading: headingAbove(table),
      headers: [...rows[headerIdx].cells].map((c) => clean(c.textContent)),
      rows: rows.slice(headerIdx + 1).map((r) => [...r.cells].map(cellInfo)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

const SECTIONS = ['kra', 'required', 'bonus'];

export function sectionFromText(s) {
  if (/bonus/i.test(s)) return 'bonus';
  if (/required|annual/i.test(s)) return 'required';
  if (/key result|\bkras?\b/i.test(s)) return 'kra';
  return null;
}

export function slugify(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

const isNA = (t) => /^n\/?a$/i.test(t);
const isBool = (t) => /^(true|false|yes|no)$/i.test(t);

/** "$8,000.00" -> 8000, "True" -> 1, "N/A" / "" -> null */
export function parseValue(t) {
  t = (t ?? '').trim();
  if (!t || isNA(t) || t === '-' || t === '—') return null;
  if (/^(true|yes)$/i.test(t)) return 1;
  if (/^(false|no)$/i.test(t)) return 0;
  const neg = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[$,%\s()]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

function kindOf(result, goal) {
  if (isBool(result) || isBool(goal)) return 'boolean';
  if (result.includes('$') || goal.includes('$')) return 'currency';
  return 'number';
}

function rgb(s) {
  const m = s.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) < 0.2) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Whole-word match where "_", "-", "." and "/" also count as word breaks, so
// "circle_red.png" and "fa-check" match but "table-bordered" and "checkbox" don't.
const word = (list) => new RegExp(`(^|[^a-z])(${list})([^a-z]|$)`);
const RED_HINT = word('not[-_ ]?met|unmet|incomplete|red|danger|fail(ed)?|error|cross|x-circle|times-circle');
const GREEN_HINT = word('met|green|success|check(mark)?|complete|done|pass(ed)?|ok|tick');

/** Nationals' status dot -> true (green), false (red) or null (can't tell). */
export function dotState(cell) {
  if (!cell) return null;
  const h = cell.hints || '';
  if (RED_HINT.test(h)) return false;
  if (GREEN_HINT.test(h)) return true;
  for (const c of cell.colors || []) {
    const v = rgb(c);
    if (!v) continue;
    const [r, g, b] = v;
    if (g > r + 40 && g > b) return true;
    if (r > g + 60 && r > b + 30) return false;
  }
  return null;
}

function columnMap(headers) {
  const find = (re) => headers.findIndex((h) => re.test(h));
  const name = Math.max(0, find(/\bkra\b|name|item/i));
  const result = find(/result/i);
  const goal = find(/goal/i);
  const outOf = find(/out\s*of|possible|max/i);
  const points = headers.findIndex((h, i) => i !== outOf && /^points?$|earned/i.test(h));
  const used = new Set([name, result, goal, points, outOf]);
  // The dot column usually has no header text; take the first unused one.
  let status = headers.findIndex((h, i) => !used.has(i) && (!h || /status|met/i.test(h)));
  if (status < 0) status = headers.length; // dot may sit in an extra headerless cell
  return {
    name,
    result: result >= 0 ? result : 1,
    goal: goal >= 0 ? goal : 2,
    points: points >= 0 ? points : 3,
    outOf: outOf >= 0 ? outOf : 4,
    status,
  };
}

/**
 * @param {Array<{heading: string, headers: string[], rows: object[][]}>} tables
 * @returns {{rows: object[], totals: object, reported: object, warnings: string[]}}
 */
export function parseKraTables(tables) {
  const rows = [];
  const warnings = [];
  const reported = {}; // totals rows printed by nationals, when present
  const seenIds = new Set();
  const order = { kra: 0, required: 0, bonus: 0 };

  tables.forEach((table, ti) => {
    let section = sectionFromText(table.heading) ?? sectionFromText(table.headers[0] ?? '') ?? SECTIONS[ti] ?? null;
    if (!section) { warnings.push(`Skipped a KRA-style table with heading "${table.heading}"`); return; }
    const col = columnMap(table.headers);

    for (const cells of table.rows) {
      const texts = cells.map((c) => c.text);
      if (!texts.some(Boolean)) continue;

      // A full-width row inside the table can switch sections ("Bonus").
      if (cells.length === 1 || (cells[0]?.colspan ?? 1) >= 3) {
        section = sectionFromText(texts.join(' ')) ?? section;
        continue;
      }

      const name = texts[col.name] ?? '';
      if (!name) continue;
      const pointsN = parseValue(texts[col.points]);
      const outOfN = parseValue(texts[col.outOf]);
      if (/^(total|totals|grand total)\b/i.test(name)) {
        reported[section] = { points: pointsN, out_of: outOfN };
        continue;
      }

      const result = texts[col.result] ?? '';
      const goal = texts[col.goal] ?? '';
      let met = dotState(cells[col.status]) ?? dotState(cells[cells.length - 1]);
      if (met === null && outOfN != null && outOfN > 0 && pointsN != null) met = pointsN >= outOfN;

      let id = `${section}-${slugify(name)}`;
      for (let n = 2; seenIds.has(id); n++) id = `${section}-${slugify(name)}-${n}`;
      seenIds.add(id);

      rows.push({
        id,
        section,
        name,
        kind: kindOf(result, goal),
        result_text: result,
        goal_text: goal,
        current: parseValue(result),
        goal: parseValue(goal),
        points: pointsN,
        out_of: outOfN,
        met,
        sort_order: order[section]++,
      });
    }
  });

  const totals = {};
  for (const s of SECTIONS) {
    const inSection = rows.filter((r) => r.section === s);
    totals[s] = {
      count: inSection.length,
      met: inSection.filter((r) => r.met).length,
      points: round(inSection.reduce((a, r) => a + (r.points ?? 0), 0)),
      out_of: round(inSection.reduce((a, r) => a + (r.out_of ?? 0), 0)),
    };
    const rep = reported[s];
    if (rep && (rep.points !== totals[s].points || rep.out_of !== totals[s].out_of)) {
      warnings.push(`${s} totals don't match nationals: parsed ${totals[s].points}/${totals[s].out_of}, page says ${rep.points}/${rep.out_of}`);
    }
  }
  return { rows, totals, reported, warnings };
}

const round = (n) => Math.round(n * 100) / 100;
