// The Board tab: columns of issues. On a phone one column fills the screen and
// you swipe sideways; on a desktop the columns sit side by side.
// Moving a card: open it and pick a column, or press and hold to drag it.

import { $, $$, cleanUrl, confirmSheet, daysUntil, esc, field, fmtDate, fmtStamp, formData, host, openSheet, opt, safeUrl, toast } from './ui.js';
import { S, sb, activeTeams, column, isMember, load, profile, sortBetween, team, teamChips, teamsOfIssue, write } from './store.js';
import { asMember } from './auth.js';

const filters = { team: '', goal: '', due: false, q: '' };
let sortables = [];
let observer = null;

// ---------- Custom fields ----------

function fieldInput(f, value) {
  const name = `cf_${f.id}`;
  const v = value ?? '';
  if (f.type === 'checkbox') return `<label class="switch"><span>${esc(f.name)}</span><input type="checkbox" name="${name}"${v === true ? ' checked' : ''}></label>`;
  if (f.type === 'select') return field(f.name, `<select class="input" name="${name}">${opt('', '—', v)}${(f.options || []).map((o) => opt(o, o, v)).join('')}</select>`);
  const type = { number: 'number', date: 'date', link: 'url', text: 'text' }[f.type] || 'text';
  const extra = f.type === 'number' ? ' inputmode="decimal" step="any"' : f.type === 'link' ? ' inputmode="url" autocapitalize="none" placeholder="https://"' : '';
  return field(f.name, `<input class="input" name="${name}" type="${type}"${extra} value="${esc(v)}" maxlength="500">`);
}
function fieldText(f, v) {
  if (v == null || v === '' || v === false) return null;
  if (f.type === 'checkbox') return 'Yes';
  if (f.type === 'date') return fmtDate(v);
  return String(v);
}
function fieldHtml(f, v) {
  const t = fieldText(f, v);
  if (t == null) return null;
  if (f.type === 'link') { const u = safeUrl(v); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(host(u))}</a>` : esc(t); }
  return esc(t);
}

// ---------- Board ----------

function visibleIssues() {
  const q = filters.q.toLowerCase();
  return S.issues.filter((i) => {
    if (filters.goal && i.goal_id !== filters.goal) return false;
    if (filters.team && !S.issueTeams.some((x) => x.issue_id === i.id && x.team_id === filters.team)) return false;
    if (filters.due && !(i.due_date && daysUntil(i.due_date) <= 7)) return false;
    if (q && !(`${i.title} ${i.description || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function cardHtml(i, done) {
  const goal = S.goals.find((g) => g.id === i.goal_id);
  const teams = teamsOfIssue(i.id);
  const late = i.due_date && !done && daysUntil(i.due_date) < 0;
  const links = (i.links || []).length;
  const shown = S.fields.filter((f) => f.show_on_card).map((f) => [f, fieldText(f, i.custom?.[f.id])]).filter(([, t]) => t != null);
  return `<article class="icard" data-issue="${i.id}" tabindex="0" role="button" aria-label="${esc(i.title)}">
    <span class="i-title">${esc(i.title)}</span>
    ${goal ? `<span class="i-goal">↳ ${esc(goal.title)}</span>` : ''}
    ${teamChips(teams)}
    ${i.due_date || links || shown.length ? `<span class="i-meta">
      ${i.due_date ? `<span class="due${late ? ' is-late' : ''}">Due ${esc(fmtDate(i.due_date))}</span>` : ''}
      ${links ? `<span>${links} link${links === 1 ? '' : 's'}</span>` : ''}
      ${shown.map(([f, t]) => `<span>${esc(f.name)}: ${esc(f.type === 'link' ? host(t) : t)}</span>`).join('')}
    </span>` : ''}
  </article>`;
}

export function renderBoard() {
  const el = $('#scene-board');
  if (!el || el.hidden) return;
  if (S.error && !S.loaded) { el.innerHTML = `<p class="app-note">Couldn't load the board. Check your connection; it will retry.</p>`; return; }
  if (!S.loaded) { el.innerHTML = '<p class="empty">Loading…</p>'; return; }
  // Keep the member where they were: which column, how far down, and what they were typing.
  const old = $('.cols', el);
  const keep = old ? { left: old.scrollLeft, tops: $$('.col-list', old).map((c) => c.scrollTop) } : null;
  const typing = document.activeElement?.id === 'board-q';
  const issues = visibleIssues();
  const member = isMember();
  const filtered = Boolean(filters.team || filters.goal || filters.due || filters.q);
  const cols = S.columns.map((c) => ({ c, list: issues.filter((i) => i.column_id === c.id).sort((a, b) => a.sort - b.sort) }));

  el.innerHTML = `<div class="app-head"><h2>Board</h2>
      <button class="btn primary small" type="button" data-issue-new><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>New</button>
    </div>
    <div class="filters">
      <select class="mini" id="board-team" aria-label="Filter by position or committee">${opt('', 'Everyone', filters.team)}${activeTeams().map((t) => opt(t.id, t.name, filters.team)).join('')}</select>
      <select class="mini" id="board-goal" aria-label="Filter by goal">${opt('', 'All goals', filters.goal)}${S.goals.map((g) => opt(g.id, g.title, filters.goal)).join('')}</select>
      <button class="pill toggle" type="button" id="board-due" aria-pressed="${filters.due}">Due this week</button>
      <input class="search" id="board-q" type="search" placeholder="Search" aria-label="Search issues" value="${esc(filters.q)}" enterkeyhint="search">
    </div>
    <div class="pills col-pills" role="tablist" aria-label="Columns">${cols.map(({ c, list }, n) => `<button class="pill${n === 0 ? ' is-on' : ''}" type="button" role="tab" data-col-pill="${c.id}">${esc(c.name)}<b>${list.length}</b></button>`).join('')}</div>
    <div class="cols">${cols.map(({ c, list }) => `<section class="col${c.is_done ? ' is-done' : ''}" data-col="${c.id}" aria-label="${esc(c.name)}">
        <div class="col-head">${esc(c.name)}<span>${list.length}</span></div>
        <div class="col-list" data-col="${c.id}">${list.map((i) => cardHtml(i, c.is_done)).join('') || `<p class="empty-col">${filtered ? 'Nothing matches the filters.' : 'Nothing here.'}</p>`}</div>
        ${member ? `<button class="btn quiet small col-add" type="button" data-issue-new="${c.id}">+ Add an issue</button>` : ''}
      </section>`).join('')}</div>
    ${member ? '' : '<p class="muted small-text">Anyone can look. <button class="btn small" type="button" data-act="signin">Sign in</button> to add or move issues.</p>'}`;

  const colsEl = $('.cols', el);
  if (keep) { colsEl.scrollLeft = keep.left; $$('.col-list', colsEl).forEach((c, n) => { c.scrollTop = keep.tops[n] || 0; }); }
  if (typing) { const q = $('#board-q', el); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  wirePills(colsEl);
  wireDrag(colsEl, member);
}

// The pill for whichever column is on screen is highlighted; tapping a pill goes to its column.
function wirePills(colsEl) {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting && en.intersectionRatio > 0.6) $$('[data-col-pill]').forEach((p) => p.classList.toggle('is-on', p.dataset.colPill === en.target.dataset.col));
    }
  }, { root: colsEl, threshold: [0.6] });
  $$('.col', colsEl).forEach((c) => observer.observe(c));
}

function wireDrag(colsEl, member) {
  sortables.forEach((x) => x.destroy());
  sortables = [];
  if (!member || !window.Sortable) return;
  for (const list of $$('.col-list', colsEl)) {
    sortables.push(new window.Sortable(list, {
      group: 'board', draggable: '.icard', animation: 150,
      delay: 220, delayOnTouchOnly: true, touchStartThreshold: 6, // press and hold on a phone, so swiping still scrolls
      forceFallback: true, fallbackTolerance: 5, // same drag behaviour in every browser; a tap still opens the card
      ghostClass: 'sortable-ghost', chosenClass: 'sortable-chosen', scroll: true, bubbleScroll: true,
      onEnd: async (ev) => {
        const id = ev.item.dataset.issue, to = ev.to.dataset.col;
        const issue = S.issues.find((i) => i.id === id);
        if (!issue || (ev.from === ev.to && ev.oldIndex === ev.newIndex)) return;
        const sortOf = (el) => (el?.classList.contains('icard') ? S.issues.find((i) => i.id === el.dataset.issue)?.sort : null) ?? null;
        const patch = { column_id: to, sort: sortBetween(sortOf(ev.item.previousElementSibling), sortOf(ev.item.nextElementSibling)) };
        Object.assign(issue, patch); // show it where it was dropped right away
        try { await write(sb.from('issues').update(patch).eq('id', id)); } finally { await load(); }
      },
    }));
  }
}

document.addEventListener('change', (e) => {
  if (e.target.id === 'board-team') { filters.team = e.target.value; renderBoard(); }
  if (e.target.id === 'board-goal') { filters.goal = e.target.value; renderBoard(); }
});
document.addEventListener('input', (e) => { if (e.target.id === 'board-q') { filters.q = e.target.value; renderBoard(); } });
document.addEventListener('click', (e) => {
  if (e.target.closest('#board-due')) { filters.due = !filters.due; return renderBoard(); }
  const pill = e.target.closest('[data-col-pill]');
  if (pill) return $(`.col[data-col="${pill.dataset.colPill}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  const add = e.target.closest('[data-issue-new]');
  if (add) return asMember(() => openIssue(null, { column_id: add.dataset.issueNew || undefined, goal_id: filters.goal || undefined }));
  const card = e.target.closest('#scene-board [data-issue]');
  if (card) openIssue(card.dataset.issue);
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('#scene-board [data-issue]')) { e.preventDefault(); openIssue(e.target.dataset.issue); }
});

// ---------- Issue sheet ----------

const linkRow = (l = {}) => `<div class="link-row">
  <input class="input" data-link="label" placeholder="Label" maxlength="120" value="${esc(l.label || '')}" aria-label="Link label">
  <input class="input" data-link="url" type="url" inputmode="url" autocapitalize="none" placeholder="https://" maxlength="2000" value="${esc(l.url || '')}" aria-label="Link address">
  <button class="btn quiet" type="button" data-do="unlink" aria-label="Remove this link">✕</button></div>`;

/** Open an issue to view or edit; `id` null starts a new one with `defaults`. */
export function openIssue(id, defaults = {}, after) {
  const existing = id ? S.issues.find((i) => i.id === id) : null;
  if (id && !existing) return toast("That issue isn't here any more.");
  if (!isMember()) return existing ? openIssueReadOnly(existing) : asMember(() => openIssue(null, defaults, after));
  const i = existing || { column_id: defaults.column_id || S.columns[0]?.id, goal_id: defaults.goal_id || '', links: [], custom: {} };
  const mine = new Set(existing ? S.issueTeams.filter((x) => x.issue_id === id).map((x) => x.team_id) : []);
  if (id) history.replaceState(null, '', `#board/${id}`);

  const s = openSheet({
    title: existing ? 'Issue' : 'New issue', primary: 'Save',
    onClose: () => { if (id && location.hash === `#board/${id}`) history.replaceState(null, '', '#board'); },
    html: `<div class="form-error" role="alert"></div>
      <div class="fsec">
        ${field('Title', `<input class="input" name="title" maxlength="160" value="${esc(i.title || '')}" placeholder="What needs doing" required>`)}
        ${field('Details (optional)', `<textarea class="input" name="description" maxlength="4000">${esc(i.description || '')}</textarea>`)}
        <div class="row2">
          ${field(existing ? 'Move to' : 'Column', `<select class="input" name="column_id">${S.columns.map((c) => opt(c.id, c.name, i.column_id)).join('')}</select>`)}
          ${field('Deadline', `<input class="input" name="due_date" type="date" value="${esc(i.due_date || '')}">`)}
        </div>
        ${field('Goal', `<select class="input" name="goal_id">${opt('', 'No goal', i.goal_id || '')}${S.goals.map((g) => opt(g.id, g.title, i.goal_id || '')).join('')}</select>`)}
      </div>
      <div class="fsec"><h3>Assigned to</h3>
        <div class="checks" style="margin-bottom:.85rem">${activeTeams().map((t) => `<label class="check"><input type="checkbox" name="teams" data-multi value="${t.id}"${mine.has(t.id) ? ' checked' : ''}><span>${esc(t.name)}</span></label>`).join('') || '<span class="muted small-text">No positions or committees yet. An admin adds them.</span>'}</div>
      </div>
      <div class="fsec"><h3>Document links</h3>
        <div data-links>${(i.links || []).map(linkRow).join('')}</div>
        <button class="btn small" type="button" data-do="link" style="margin-bottom:.85rem">+ Add a link</button>
      </div>
      ${S.fields.length ? `<div class="fsec"><h3>More</h3>${S.fields.map((f) => fieldInput(f, i.custom?.[f.id])).join('')}</div>` : ''}
      <div data-activity></div>
      ${existing ? '<div class="btn-row"><button class="btn danger" type="button" data-do="archive">Archive issue</button></div>' : ''}`,
    onPrimary: async () => {
      const f = formData(s.body);
      if (!f.title) return s.error('Give the issue a title.');
      const links = [];
      for (const row of $$('.link-row', s.body)) {
        const label = $('[data-link="label"]', row).value.trim(), raw = $('[data-link="url"]', row).value.trim();
        if (!label && !raw) continue;
        const url = cleanUrl(raw);
        if (!url) return s.error(`"${raw}" isn't a web address, like docs.google.com/...`);
        links.push({ label: label || host(url), url });
      }
      const custom = {};
      for (const cf of S.fields) {
        const v = f[`cf_${cf.id}`];
        if (cf.type === 'checkbox') { if (v) custom[cf.id] = true; continue; }
        if (v === '' || v == null) continue;
        if (cf.type === 'link' && !cleanUrl(v)) return s.error(`${cf.name} must be a web address, like docs.google.com/...`);
        custom[cf.id] = cf.type === 'number' ? Number(v) : cf.type === 'link' ? cleanUrl(v) : v;
      }
      const row = { title: f.title, description: f.description || null, column_id: f.column_id, goal_id: f.goal_id || null, due_date: f.due_date || null, links, custom };
      let issueId = id;
      if (existing) {
        if (row.column_id !== existing.column_id) row.sort = sortBetween(Math.max(0, ...S.issues.filter((x) => x.column_id === row.column_id).map((x) => x.sort)), null);
        await write(sb.from('issues').update(row).eq('id', id));
      } else {
        row.sort = sortBetween(Math.max(0, ...S.issues.filter((x) => x.column_id === row.column_id).map((x) => x.sort)), null);
        issueId = (await write(sb.from('issues').insert(row).select('id').single())).id;
      }
      const want = new Set(f.teams || []);
      const add = [...want].filter((t) => !mine.has(t)), drop = [...mine].filter((t) => !want.has(t));
      if (add.length) await write(sb.from('issue_teams').insert(add.map((team_id) => ({ issue_id: issueId, team_id }))));
      if (drop.length) await write(sb.from('issue_teams').delete().eq('issue_id', issueId).in('team_id', drop));
      await load();
      s.close();
      toast(existing ? 'Issue saved.' : 'Issue added.');
      after?.();
    },
  });

  s.body.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-do]')?.dataset.do;
    if (act === 'link') { $('[data-links]', s.body).insertAdjacentHTML('beforeend', linkRow()); $$('.link-row [data-link="label"]', s.body).pop().focus(); }
    if (act === 'unlink') e.target.closest('.link-row').remove();
    if (act === 'archive') {
      if (!(await confirmSheet('Archive this issue?', 'It leaves the board. An admin can restore it.', 'Archive'))) return;
      await write(sb.from('issues').update({ archived_at: new Date().toISOString() }).eq('id', id));
      await load();
      s.close();
      toast('Issue archived.');
      after?.();
    }
  });
  if (existing) loadActivity(id, $('[data-activity]', s.body));
  else setTimeout(() => $('[name="title"]', s.body)?.focus(), 50);
}

async function loadActivity(id, slot) {
  const { data } = await sb.from('activity').select('at,actor,action,summary').eq('entity', 'issue').eq('entity_id', id).order('id', { ascending: false }).limit(8);
  if (!data?.length || !slot?.isConnected) return;
  slot.innerHTML = `<div class="fsec plain"><h3>Recent changes</h3><ul class="act">${data.map((a) => `<li><b>${esc(profile(a.actor)?.name || 'Someone')}</b> ${esc(a.action)}${a.action === 'moved' ? ` ${esc((a.summary || '').split(' → ').pop() ? 'to ' + (a.summary || '').split(' → ').pop() : '')}` : ''} · ${esc(fmtStamp(a.at))}</li>`).join('')}</ul></div>`;
}

function openIssueReadOnly(i) {
  const goal = S.goals.find((g) => g.id === i.goal_id);
  const teams = teamsOfIssue(i.id);
  const links = (i.links || []).map((l) => [l, safeUrl(l.url)]).filter(([, u]) => u);
  const customs = S.fields.map((f) => [f, fieldHtml(f, i.custom?.[f.id])]).filter(([, h]) => h != null);
  history.replaceState(null, '', `#board/${i.id}`);
  const s = openSheet({
    title: 'Issue',
    onClose: () => { if (location.hash === `#board/${i.id}`) history.replaceState(null, '', '#board'); },
    html: `<div class="fsec plain"><h3 style="font-size:1.25rem;color:var(--text);text-transform:none;letter-spacing:0">${esc(i.title)}</h3>
        ${i.description ? `<p class="prose">${esc(i.description)}</p>` : ''}</div>
      <div class="fsec plain"><dl class="kv">
        <dt>Column</dt><dd>${esc(column(i.column_id)?.name || '')}</dd>
        ${i.due_date ? `<dt>Deadline</dt><dd>${esc(fmtDate(i.due_date))}</dd>` : ''}
        ${goal ? `<dt>Goal</dt><dd>${esc(goal.title)}</dd>` : ''}
        ${teams.length ? `<dt>Assigned to</dt><dd>${teamChips(teams)}</dd>` : ''}
        ${links.length ? `<dt>Links</dt><dd>${links.map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(l.label || host(u))}</a>`).join('<br>')}</dd>` : ''}
        ${customs.map(([f, h]) => `<dt>${esc(f.name)}</dt><dd>${h}</dd>`).join('')}
      </dl></div>
      <div data-activity></div>
      <p class="muted small-text"><button class="btn small" type="button" data-act="signin">Sign in</button> to edit or move this issue.</p>`,
  });
  s.body.addEventListener('click', (e) => { if (e.target.closest('[data-act="signin"]')) s.close(); });
  loadActivity(i.id, $('[data-activity]', s.body));
}
