// The Finances tab: the chapter budget from the Treasurer's Google Sheet.
// Every signed-in brother can see it; visitors and the TV can't (the database
// enforces that). The sync copies only the Sheet's "Chapter Expenses" table:
// each line's budget and what's been spent. Nothing here writes.
//
// Charts follow the dashboard's data-viz rules: the two splits are tall
// segmented bars (a phone can't read a 14-slice pie), the colours are a
// validated categorical set in a fixed order, red is kept for "over budget"
// and always comes with an icon and words, and every part also appears in a
// legend with its amount.

import { $, esc } from './ui.js';
import { S, sb, isMember } from './store.js';

const D = window.DASH;
const F = { lines: [], sync: null, loadedFor: null, loading: null, error: null, at: 0 };

// Categorical slots 1-7, validated on the white panel (red is left out: it means over budget).
const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'];
const OTHER = '#8e8e93';
const INK = '#131315';

export function resetFinance() { Object.assign(F, { lines: [], sync: null, loadedFor: null, loading: null, error: null, at: 0 }); }

export function loadFinance() {
  if (!isMember()) return Promise.resolve();
  if (F.loading) return F.loading;
  const who = S.user.id;
  F.loading = Promise.all([
    sb.from('budget_lines').select('name, budgeted, spent, sort').order('sort'),
    sb.from('budget_sync').select('synced_at, tried_at, problem').maybeSingle(),
  ]).then(([lines, sync]) => {
    if (S.user?.id !== who) return;
    if (lines.error) throw lines.error;
    F.lines = (lines.data || []).map((l) => ({ ...l, budgeted: Number(l.budgeted), spent: Number(l.spent) }));
    F.sync = sync.data || null;
    F.error = null;
    F.loadedFor = who;
    F.at = Date.now();
  }).catch((e) => { F.error = e; }).finally(() => {
    F.loading = null;
    if (D.scene() === 'finance') renderFinance();
  });
  return F.loading;
}

// ---------- Formatting ----------

const usd = (n, cents = true) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);
const pctText = (p) => (p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`);
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// White or near-black text on a coloured block, whichever reads better.
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const inkOn = (hex) => ((1.05) / (lum(hex) + 0.05) >= (lum(hex) + 0.05) / (lum(INK) + 0.05) ? '#ffffff' : INK);

const OVER_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" style="fill:var(--over)"/><path d="M12 6.6v6.6" style="fill:none;stroke:#fff;stroke-width:2.8;stroke-linecap:round"/><circle cx="12" cy="17.2" r="1.6" style="fill:#fff"/></svg>';

// ---------- The two splits ----------

// Each split shows its biggest parts and folds the rest into "Other". A line
// keeps one colour across both bars, so at most 7 named lines appear in all.
function colourPlan(lines) {
  const top = (key, n) => lines.filter((l) => l[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, n).map((l) => l.name);
  let n = 5, names;
  for (; n >= 1; n--) {
    names = new Set([...top('budgeted', n), ...top('spent', n)]);
    if (names.size <= COLORS.length) break;
  }
  const ordered = lines.filter((l) => names.has(l.name)).map((l) => l.name); // sheet order: stable colours
  return { n, colour: new Map(ordered.map((name, i) => [name, COLORS[i]])) };
}

function split(lines, key, plan, title) {
  const total = lines.reduce((s, l) => s + Math.max(0, l[key]), 0);
  if (total <= 0) return `<section class="panel fin-card"><h3 class="fin-h">${esc(title)}</h3><p class="muted">Nothing yet.</p></section>`;
  const named = lines.filter((l) => l[key] > 0 && plan.colour.has(l.name)).sort((a, b) => b[key] - a[key]).slice(0, plan.n);
  const rest = lines.filter((l) => l[key] > 0 && !named.includes(l));
  const parts = named.map((l) => ({ name: l.name, value: l[key], colour: plan.colour.get(l.name) }));
  const restSum = rest.reduce((s, l) => s + l[key], 0);
  if (restSum > 0) parts.push({ name: `Other (${rest.length})`, value: restSum, colour: OTHER, other: rest.map((l) => l.name) });
  const label = `${title}: ${parts.map((p) => `${p.name} ${usd(p.value)}, ${pctText(pct(p.value, total))}`).join('; ')}`;
  const blocks = parts.map((p) => {
    const share = pct(p.value, total);
    const tip = `${p.name} · ${usd(p.value)} · ${pctText(share)}${p.other ? ` — ${p.other.join(', ')}` : ''}`;
    return `<span class="fin-seg" style="flex:${share.toFixed(3)} 1 0;background:${p.colour};color:${inkOn(p.colour)}" tabindex="0" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}">${share >= 11 ? pctText(share) : ''}</span>`;
  }).join('');
  const legend = parts.map((p) => {
    const share = pct(p.value, total);
    return `<li><i class="sw" style="background:${p.colour}"></i><span class="fin-lname">${esc(p.name)}</span><span class="fin-lval">${usd(p.value, false)}${share < 11 ? ` · ${pctText(share)}` : ''}</span></li>`;
  }).join('');
  return `<section class="panel fin-card">
      <h3 class="fin-h">${esc(title)}</h3>
      <p class="fin-sub muted">${usd(total, false)} in all</p>
      <div class="fin-split" role="group" aria-label="${esc(label)}">${blocks}</div>
      <ul class="fin-legend">${legend}</ul>
    </section>`;
}

// ---------- Each line: spent against its budget ----------

function lineRow(l) {
  const over = l.spent > l.budgeted;
  const scale = Math.max(l.budgeted, l.spent);
  const fill = scale > 0 ? pct(l.spent, scale) : 0;
  const mark = over && l.budgeted > 0 ? pct(l.budgeted, scale) : null;
  let status;
  if (l.budgeted <= 0 && l.spent <= 0) status = '<span class="muted">Nothing budgeted</span>';
  else if (l.budgeted <= 0) status = `<span class="fin-over">${OVER_ICON}<b>Not budgeted</b></span>`;
  else if (over) status = `<span class="fin-over">${OVER_ICON}<b>Over by ${usd(l.spent - l.budgeted)}</b></span>`;
  else status = `<span class="muted">${usd(l.budgeted - l.spent)} left · ${pctText(pct(l.spent, l.budgeted))} spent</span>`;
  const aria = `${l.name}: ${usd(l.spent)} spent of ${usd(l.budgeted)} budgeted${over ? `, over by ${usd(l.spent - l.budgeted)}` : ''}`;
  return `<li class="fin-line${over ? ' is-over' : ''}${scale <= 0 ? ' is-empty' : ''}">
      <div class="fin-top"><span class="fin-name">${esc(l.name)}</span><span class="fin-fig"><b>${usd(l.spent)}</b> <span class="muted">of ${usd(l.budgeted)}</span></span></div>
      <span class="fin-meter" role="img" aria-label="${esc(aria)}" data-tip="${esc(aria)}" tabindex="0"><span class="fin-fill" style="width:${fill.toFixed(1)}%"></span>${mark != null ? `<span class="fin-mark" style="left:${mark.toFixed(1)}%"></span>` : ''}</span>
      <div class="fin-status">${status}</div>
    </li>`;
}

// ---------- The screen ----------

export function renderFinance() {
  const el = $('#scene-finance');
  if (!el || el.hidden) return;
  if (!isMember()) {
    el.innerHTML = `<div class="app-head"><h2>Finances</h2></div><p class="empty">Sign in to see the chapter budget.</p>`;
    return;
  }
  if (F.loadedFor !== S.user.id) {
    if (!F.loading && !F.error) loadFinance();
    if (!F.error) { el.innerHTML = `<div class="app-head"><h2>Finances</h2></div><p class="empty">Loading…</p>`; return; }
  }
  if (F.error && !F.lines.length) {
    el.innerHTML = `<div class="app-head"><h2>Finances</h2></div><p class="empty">The budget couldn't be loaded. Check your connection and try again.</p>`;
    return;
  }
  const lines = F.lines;
  const sync = F.sync;
  const updated = sync?.synced_at ? `From the Treasurer's budget sheet · updated ${ago(sync.synced_at)}` : "From the Treasurer's budget sheet";
  const stale = sync?.problem && sync.tried_at && (!sync.synced_at || new Date(sync.tried_at) > new Date(sync.synced_at));
  const notice = stale ? `<div class="fin-notice">The budget sheet couldn't be read ${esc(ago(sync.tried_at))}${sync.synced_at ? `, so these are the numbers from ${esc(ago(sync.synced_at))}` : ''}.${S.profile?.is_admin ? ` <span class="muted">(${esc(sync.problem)})</span>` : ''}</div>` : '';

  if (!lines.length) {
    el.innerHTML = `<div class="app-head"><h2>Finances</h2></div>${notice}<p class="empty">The budget hasn't been loaded from the Treasurer's sheet yet.</p>`;
    return;
  }

  const budgeted = lines.reduce((s, l) => s + l.budgeted, 0);
  const spent = lines.reduce((s, l) => s + l.spent, 0);
  const left = budgeted - spent;
  const overLines = lines.filter((l) => l.spent > l.budgeted);
  const overAll = spent > budgeted;
  const plan = colourPlan(lines);
  const used = pct(spent, budgeted);

  el.innerHTML = `<div class="app-head"><h2>Finances</h2></div>
    <p class="fin-updated muted">${esc(updated)}</p>
    ${notice}
    <div class="fin">
      <section class="panel fin-card fin-totals">
        <div class="fin-kpis">
          <div><span class="eyebrow">Budgeted</span><b>${usd(budgeted, false)}</b></div>
          <div><span class="eyebrow">Spent</span><b>${usd(spent, false)}</b></div>
          <div><span class="eyebrow">${overAll ? 'Over' : 'Left'}</span><b>${usd(Math.abs(left), false)}</b></div>
        </div>
        <span class="fin-meter fin-meter-big" role="img" aria-label="${esc(`${pctText(used)} of the budget spent`)}"><span class="fin-fill${overAll ? ' is-over' : ''}" style="width:${Math.min(100, used).toFixed(1)}%"></span></span>
        <p class="fin-sub">${pctText(used)} of the budget spent${overLines.length ? ` · <span class="fin-over">${OVER_ICON}<b>${overLines.length} ${overLines.length === 1 ? 'line' : 'lines'} over budget</b></span>` : ''}</p>
      </section>
      <div class="fin-splits">
        ${split(lines, 'budgeted', plan, 'Where the budget goes')}
        ${split(lines, 'spent', plan, 'Where the money went')}
      </div>
      <section class="panel fin-card">
        <h3 class="fin-h">By line</h3>
        <p class="fin-sub muted">Spent against each line's budget. A line past its budget shows the budget as a tick.</p>
        <ul class="fin-lines">${lines.map(lineRow).join('')}</ul>
      </section>
    </div>
    <div class="fin-tip" role="tooltip" hidden></div>`;
}

// One tooltip for every chart part: hover or keyboard focus on a computer, a tap on a phone.
function showTip(target) {
  const tip = $('#scene-finance .fin-tip');
  if (!tip) return;
  if (!target) { tip.hidden = true; return; }
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const scene = $('#scene-finance');
  const r = target.getBoundingClientRect(), s = scene.getBoundingClientRect();
  const w = tip.offsetWidth;
  const x = Math.min(Math.max(r.left + r.width / 2 - s.left - w / 2, 4), s.width - w - 4);
  tip.style.left = `${x}px`;
  tip.style.top = `${r.top - s.top - tip.offsetHeight - 8}px`;
}
document.addEventListener('pointerover', (e) => { const t = e.target.closest?.('#scene-finance [data-tip]'); if (t && e.pointerType === 'mouse') showTip(t); });
document.addEventListener('pointerout', (e) => { if (e.pointerType === 'mouse' && e.target.closest?.('#scene-finance [data-tip]')) showTip(null); });
document.addEventListener('focusin', (e) => { const t = e.target.closest?.('#scene-finance [data-tip]'); showTip(t || null); });
document.addEventListener('click', (e) => {
  if (!$('#scene-finance') || $('#scene-finance').hidden) return;
  const t = e.target.closest?.('#scene-finance [data-tip]');
  showTip(t || null);
});

export const financeAge = () => F.at;
