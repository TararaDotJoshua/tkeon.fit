// Read the chapter's place in nationals' public KRA ranking.
//
// https://tke.org/about-us/tke-today/chapter-rankings/ is a public page (no
// login) whose first table, "Key Result Area Ranks", lists every chapter with
// its rank, region and score. We keep only our own row's numbers, plus how many
// chapters are ranked nationally and in our region.

export const RANKINGS_URL = 'https://tke.org/about-us/tke-today/chapter-rankings/';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const text = (html) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  })
  .replace(/\s+/g, ' ')
  .trim();

const int = (s) => { const m = String(s).replace(/,/g, '').match(/-?\d+/); return m ? Number(m[0]) : null; };

/** "↑ 24" -> 24 (moved up 24 places), "↓ 3" -> -3, "0" -> 0, anything else -> null. */
export function parseMove(s) {
  const n = int(s);
  if (n == null) return null;
  if (/[↑▲]/.test(s)) return Math.abs(n);
  if (/[↓▼]/.test(s)) return -Math.abs(n);
  return n === 0 ? 0 : null;
}

function tables(html) {
  const out = [];
  for (const t of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((r) => [...r[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => text(c[1])))
      .filter((cells) => cells.length);
    if (rows.length > 1) out.push(rows);
  }
  return out;
}

/**
 * @param {string} html      the rankings page
 * @param {string} chapter   our chapter as the page spells it, e.g. "Omicron-Nu"
 */
export function parseRankings(html, chapter) {
  const want = chapter.trim().toLowerCase();
  for (const rows of tables(html)) {
    const head = rows[0].map((h) => h.toLowerCase());
    const col = (re) => head.findIndex((h) => re.test(h));
    const c = { rank: col(/^rank$/), chapter: col(/^chapter$/), region: col(/^region$/), score: col(/^score$/), day: col(/yesterday/), week: col(/week/), prev: col(/prev/) };
    // The KRA table is the one with a Score column; the others rank by a count.
    if (c.rank < 0 || c.chapter < 0 || c.region < 0 || c.score < 0) continue;

    const data = rows.slice(1).map((r) => ({ r, rank: int(r[c.rank]), name: (r[c.chapter] || '').toLowerCase(), region: r[c.region] || '' })).filter((x) => x.rank != null && x.name);
    const ours = data.find((x) => x.name === want);
    if (!ours) throw new Error(`"${chapter}" isn't in the KRA ranking table (${data.length} chapters listed). Check chapterName in tke.config.json.`);
    if (data.length < 20) throw new Error(`The KRA ranking table only has ${data.length} rows; the page may have changed.`);
    const inRegion = data.filter((x) => x.region === ours.region);
    const prev = c.prev >= 0 ? int(ours.r[c.prev]) : null;
    return {
      national_rank: ours.rank,
      national_total: data.length,
      region: ours.region,
      // Ties share a place, like the national column: 1 + chapters ranked above us.
      region_rank: 1 + inRegion.filter((x) => x.rank < ours.rank).length,
      region_total: inRegion.length,
      score_text: ours.r[c.score] || null,
      since_yesterday: c.day >= 0 ? parseMove(ours.r[c.day]) : null,
      since_week: c.week >= 0 ? parseMove(ours.r[c.week]) : null,
      prev_year_rank: prev > 0 ? prev : null,
    };
  }
  throw new Error('No table with Rank, Chapter, Region and Score columns on the rankings page; it may have changed.');
}

export async function fetchRankingsHtml(url = RANKINGS_URL) {
  // tke.org serves this page from caches that can be hours apart (two fetches a
  // minute apart once gave rank 83 and rank 92). A changing query string and
  // no-cache ask for the current copy.
  const fresh = new URL(url);
  fresh.searchParams.set('t', String(Math.floor(Date.now() / 60000)));
  const res = await fetch(fresh, {
    headers: { 'user-agent': 'tkeon-dashboard-sync (+https://tkeon.fit/Dashboard)', accept: 'text/html', 'cache-control': 'no-cache', pragma: 'no-cache' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Rankings page answered HTTP ${res.status}.`);
  return res.text();
}
