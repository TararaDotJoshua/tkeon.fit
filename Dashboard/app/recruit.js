// The Recruitment tab: PNMs by semester, who's talking to whom, the pipeline,
// the interest form's QR code, and numbers for the rush chair.
// Only brothers an admin let in (and admins) see any of it; the database
// refuses everyone else, so hiding the tab is a convenience, not the lock.

import { $, $$, confirmSheet, daysUntil, DAY, esc, field, fmtDate, fmtStamp, formData, openSheet, opt, toast, today, ymd } from './ui.js';
import { S, sb, isMember, profile, write } from './store.js';

const D = window.DASH;

export const STAGES = [
  ['interested', 'Interested'], ['contacted', 'Contacted'], ['met', 'Met'], ['invited', 'Invited'],
  ['bid', 'Bid'], ['accepted', 'Accepted'], ['deferred', 'Deferred'], ['declined', 'Did not accept'],
];
const ACTIVE = new Set(['interested', 'contacted', 'met', 'invited', 'bid']);
const stageLabel = (k) => (STAGES.find(([v]) => v === k) || [k, k])[1];
const HOW = [['text', 'Text'], ['call', 'Call'], ['in_person', 'In person'], ['event', 'Event'], ['social', 'Social media'], ['other', 'Other']];
const howLabel = (k) => (HOW.find(([v]) => v === k) || [k, k])[1].toLowerCase();
const QUIET_DAYS = 7;

export const canRecruit = () => isMember() && Boolean(S.profile.can_recruit || S.profile.is_admin);

const R = { pnms: [], log: [], loaded: false, loading: null, error: null, term: null, view: 'people', filter: 'all', q: '', stage: '', photos: new Map() };
let pipelineSortables = [];

// ---------- Semesters ----------

/** Same rule as the database: January to May is spring, June to December is fall. */
export const termFor = (d) => `${d.getMonth() <= 4 ? 'Spring' : 'Fall'} ${d.getFullYear()}`;
const termKey = (t) => { const [s, y] = t.split(' '); return Number(y) * 2 + (s === 'Fall' ? 1 : 0); };
function terms() {
  const set = new Set(R.pnms.map((p) => p.term));
  set.add(termFor(new Date()));
  return [...set].sort((a, b) => termKey(b) - termKey(a));
}
/** This semester and the next two, for moving a PNM forward. */
function termChoices(current) {
  const out = new Set(terms());
  let d = new Date();
  for (let i = 0; i < 2; i++) { d = new Date(d.getFullYear(), d.getMonth() + 6, 1); out.add(termFor(d)); }
  if (current) out.add(current);
  return [...out].sort((a, b) => termKey(b) - termKey(a));
}

// ---------- Data ----------

export function resetRecruit() { Object.assign(R, { pnms: [], log: [], loaded: false, loading: null, error: null }); R.photos.clear(); }

export function loadRecruit() {
  if (!canRecruit()) { resetRecruit(); return Promise.resolve(); }
  R.loading ||= (async () => {
    try {
      const [p, l] = await Promise.all([
        sb.from('pnms').select('*').order('name'),
        sb.from('pnm_log').select('*').order('at'),
      ]);
      if (p.error) throw p.error;
      if (l.error) throw l.error;
      R.pnms = p.data; R.log = l.data; R.loaded = true; R.error = null;
      if (!R.term || !terms().includes(R.term)) R.term = termFor(new Date());
      await signPhotos(R.pnms.map((x) => x.photo_path).filter(Boolean));
    } catch (e) {
      R.error = e;
    } finally {
      R.loading = null;
      renderRecruit();
    }
  })();
  return R.loading;
}

/** PNM photos are private: they're shown through links that expire after an hour. */
async function signPhotos(paths) {
  const now = Date.now();
  const need = [...new Set(paths)].filter((path) => !(R.photos.get(path)?.exp > now + 5 * 60e3));
  if (!need.length) return;
  const { data } = await sb.storage.from('pnm-photos').createSignedUrls(need, 3600);
  for (const d of data || []) if (d.signedUrl && !d.error) R.photos.set(d.path, { url: d.signedUrl, exp: now + 3600e3 });
}

const inTerm = () => R.pnms.filter((p) => p.term === R.term);
const logOf = (id) => R.log.filter((l) => l.pnm_id === id);
const brothers = () => S.profiles.filter((p) => !p.disabled && p.name).sort((a, b) => a.name.localeCompare(b.name));

function facts(p) {
  const since = p.last_contact_at || p.created_at;
  const quiet = Math.floor((Date.now() - Date.parse(since)) / DAY);
  const active = ACTIVE.has(p.stage);
  return {
    active,
    quiet: active && quiet >= QUIET_DAYS ? quiet : 0,
    due: active && p.next_date && daysUntil(p.next_date) <= 0,
    unassigned: active && !p.main_contact,
    mine: p.main_contact === S.user?.id,
    dup: Boolean(p.email) && R.pnms.some((q) => q.id !== p.id && q.term === p.term && q.email === p.email),
  };
}

function photoHtml(p, size = '') {
  const url = p.photo_path && R.photos.get(p.photo_path)?.url;
  const initials = (p.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return `<span class="av pav ${size}">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : esc(initials)}</span>`;
}
const agoText = (iso) => { const d = Math.floor((Date.now() - Date.parse(iso)) / DAY); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };

// ---------- The tab ----------

const FILTERS = [['all', 'All'], ['mine', 'Mine'], ['due', 'Follow-ups due'], ['quiet', `Quiet ${QUIET_DAYS}+ days`], ['unassigned', 'Unassigned']];

export function renderRecruit() {
  const el = $('#scene-recruit');
  if (!el || el.hidden) return;
  if (!S.loaded) { el.innerHTML = '<p class="empty">Loading…</p>'; return; }
  if (!isMember()) {
    el.innerHTML = `<div class="app-head"><h2>Recruitment</h2></div><div class="app-note">Sign in to use Recruitment.<br><button class="btn small" type="button" data-act="signin">Sign in</button></div>`;
    return;
  }
  if (!canRecruit()) {
    el.innerHTML = `<div class="app-head"><h2>Recruitment</h2></div><div class="app-note">Recruitment is for brothers on the recruitment team. An admin can turn on your access.</div>`;
    return;
  }
  if (!R.loaded) {
    el.innerHTML = R.error ? `<p class="app-note">Couldn't load recruitment. Check your connection; it will retry.</p>` : '<p class="empty">Loading…</p>';
    if (!R.loading) loadRecruit();
    return;
  }
  const keepQ = document.activeElement?.id === 'rec-q';
  const head = `<div class="app-head"><h2>Recruitment</h2>
      <button class="btn small" type="button" data-rec="qr"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2M18 14h2v2M14 18h2v2M18 18v2h2"/></svg>QR</button>
      <button class="btn primary small" type="button" data-rec="new"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add</button>
    </div>
    <div class="rec-bar">
      <select class="mini" id="rec-term" aria-label="Semester">${terms().map((t) => opt(t, t, R.term)).join('')}</select>
      <div class="seg" role="tablist" aria-label="Recruitment views">${[['people', 'People'], ['pipeline', 'Pipeline'], ['numbers', 'Numbers']].map(([v, l]) => `<button class="seg-b" type="button" role="tab" data-view="${v}" aria-selected="${R.view === v}">${l}</button>`).join('')}</div>
    </div>`;
  const body = R.view === 'pipeline' ? pipelineHtml() : R.view === 'numbers' ? numbersHtml() : peopleHtml();
  el.innerHTML = head + body;
  if (keepQ) { const q = $('#rec-q', el); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  if (R.view === 'pipeline') wirePipeline(el);
}

function peopleHtml() {
  const list = inTerm();
  const f = new Map(list.map((p) => [p.id, facts(p)]));
  const count = (k) => (k === 'all' ? list.length : list.filter((p) => f.get(p.id)[k]).length);
  const q = R.q.toLowerCase();
  const shown = list.filter((p) => (R.filter === 'all' || f.get(p.id)[R.filter])
    && (!R.stage || p.stage === R.stage)
    && (!q || `${p.name} ${p.major || ''} ${p.email || ''} ${p.social || ''}`.toLowerCase().includes(q)))
    .sort((a, b) => (f.get(b.id).due - f.get(a.id).due) || (f.get(b.id).quiet - f.get(a.id).quiet) || a.name.localeCompare(b.name));
  return `<div class="pills">${FILTERS.map(([k, l]) => `<button class="pill${R.filter === k ? ' is-on' : ''}" type="button" data-filter="${k}">${l}<b>${count(k)}</b></button>`).join('')}</div>
    <div class="filters">
      <input class="search" id="rec-q" type="search" placeholder="Search" aria-label="Search PNMs" value="${esc(R.q)}" enterkeyhint="search">
      <select class="mini" id="rec-stage" aria-label="Stage">${opt('', 'Every stage', R.stage)}${STAGES.map(([v, l]) => opt(v, l, R.stage)).join('')}</select>
    </div>
    ${shown.length ? `<div class="plist">${shown.map((p) => cardHtml(p, f.get(p.id))).join('')}</div>`
      : `<div class="app-note">${list.length ? 'Nobody matches.' : `No PNMs in ${esc(R.term)} yet. Share the interest form's QR code, or add someone you met.`}</div>`}`;
}

function cardHtml(p, f) {
  const mc = profile(p.main_contact);
  const flags = [f.due && 'Follow-up due', f.quiet && `Quiet ${f.quiet} days`, f.unassigned && 'Unassigned', f.dup && 'Possible duplicate'].filter(Boolean);
  return `<article class="panel pcard" data-pnm="${p.id}" tabindex="0" role="button" aria-label="${esc(p.name)}, ${esc(stageLabel(p.stage))}">
    ${photoHtml(p)}
    <span class="pmain">
      <span class="pname">${esc(p.name)}</span>
      <span class="psub">${esc(stageLabel(p.stage))}${p.major ? ` · ${esc(p.major)}` : ''}</span>
      <span class="pmeta">${mc ? `With ${esc(mc.name)}` : 'No main contact'} · ${p.last_contact_at ? `contacted ${esc(agoText(p.last_contact_at))}` : 'not contacted yet'}</span>
      ${flags.length ? `<span class="flags">${flags.map((x) => `<span class="flag">${esc(x)}</span>`).join('')}</span>` : ''}
    </span>
  </article>`;
}

function pipelineHtml() {
  const list = inTerm();
  return `<div class="pills col-pills" role="tablist" aria-label="Stages">${STAGES.map(([v, l], n) => `<button class="pill${n === 0 ? ' is-on' : ''}" type="button" data-stage-pill="${v}">${l}<b>${list.filter((p) => p.stage === v).length}</b></button>`).join('')}</div>
    <div class="cols rec-cols">${STAGES.map(([v, l]) => {
      const items = list.filter((p) => p.stage === v);
      return `<section class="col${ACTIVE.has(v) ? '' : ' is-done'}" data-stage="${v}" aria-label="${esc(l)}">
        <div class="col-head">${esc(l)}<span>${items.length}</span></div>
        <div class="col-list" data-stage="${v}">${items.map((p) => { const mc = profile(p.main_contact); return `<article class="icard pmini" data-pnm="${p.id}" tabindex="0" role="button" aria-label="${esc(p.name)}">${photoHtml(p, 'sm')}<span><span class="i-title">${esc(p.name)}</span><span class="i-meta">${mc ? esc(mc.name) : 'Unassigned'}</span></span></article>`; }).join('') || '<p class="empty-col">Nobody here.</p>'}</div>
      </section>`;
    }).join('')}</div>`;
}

function wirePipeline(el) {
  pipelineSortables.forEach((x) => x.destroy());
  pipelineSortables = [];
  const colsEl = $('.rec-cols', el);
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting && en.intersectionRatio > 0.6) $$('[data-stage-pill]', el).forEach((pl) => pl.classList.toggle('is-on', pl.dataset.stagePill === en.target.dataset.stage));
  }, { root: colsEl, threshold: [0.6] });
  $$('.col', colsEl).forEach((c) => io.observe(c));
  if (!window.Sortable) return;
  for (const list of $$('.col-list', colsEl)) {
    pipelineSortables.push(new window.Sortable(list, {
      group: 'pipeline', draggable: '.pmini', sort: false, animation: 150,
      delay: 220, delayOnTouchOnly: true, touchStartThreshold: 6, forceFallback: true, fallbackTolerance: 5,
      ghostClass: 'sortable-ghost', chosenClass: 'sortable-chosen',
      onEnd: async (ev) => {
        if (ev.from === ev.to) return;
        const id = ev.item.dataset.pnm, stage = ev.to.dataset.stage;
        const p = R.pnms.find((x) => x.id === id);
        if (p) p.stage = stage;
        try { await write(sb.from('pnms').update({ stage }).eq('id', id)); toast(`Moved to ${stageLabel(stage)}.`); } finally { await loadRecruit(); }
      },
    }));
  }
}

function numbersHtml() {
  const list = inTerm();
  const max = Math.max(1, ...STAGES.map(([v]) => list.filter((p) => p.stage === v).length));
  const accepted = list.filter((p) => p.stage === 'accepted').length;
  const ids = new Set(list.map((p) => p.id));
  const contacts = R.log.filter((l) => l.kind === 'contact' && ids.has(l.pnm_id));
  const byBrother = new Map();
  for (const l of contacts) byBrother.set(l.actor, (byBrother.get(l.actor) || 0) + 1);
  const people = [...byBrother.entries()].sort((a, b) => b[1] - a[1]);
  const topContacts = Math.max(1, ...people.map(([, n]) => n));
  const load = new Map();
  for (const p of list) if (ACTIVE.has(p.stage) && p.main_contact) load.set(p.main_contact, (load.get(p.main_contact) || 0) + 1);
  const ini = (D.data()?.kras || []).find((k) => k.id === 'kra-initiates');
  const bar = (n, of) => `<span class="pbar"><span class="fill" style="width:${((n / of) * 100).toFixed(1)}%"></span></span>`;
  const flagged = (k) => list.filter((p) => facts(p)[k]).length;
  return `<div class="num-grid">
    <section class="panel num-card"><h3 class="eyebrow">${esc(R.term)}</h3>
      <div class="num-big">${list.length}<span> PNMs</span></div>
      <p class="muted small-text">${accepted} accepted${list.length ? ` · ${Math.round((accepted / list.length) * 100)}% of everyone` : ''}${ini ? ` · Initiates KRA: ${esc(String(ini.current ?? '–'))} of ${esc(String(ini.goal ?? '–'))}` : ''}</p>
      <p class="muted small-text">${flagged('unassigned')} unassigned · ${flagged('quiet')} quiet ${QUIET_DAYS}+ days · ${flagged('due')} follow-ups due</p>
    </section>
    <section class="panel num-card"><h3 class="eyebrow">By stage</h3>
      <ul class="nrows">${STAGES.map(([v, l]) => { const n = list.filter((p) => p.stage === v).length; return `<li><span>${esc(l)}</span>${bar(n, max)}<b>${n}</b></li>`; }).join('')}</ul>
    </section>
    <section class="panel num-card"><h3 class="eyebrow">Contacts logged, by brother</h3>
      ${people.length ? `<ul class="nrows">${people.map(([id, n]) => `<li><span>${esc(profile(id)?.name || 'Someone')}</span>${bar(n, topContacts)}<b>${n}</b></li>`).join('')}</ul>` : '<p class="muted small-text">No contacts logged this semester yet.</p>'}
    </section>
    <section class="panel num-card"><h3 class="eyebrow">Main contact for, still active</h3>
      ${load.size ? `<ul class="nrows">${[...load.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `<li><span>${esc(profile(id)?.name || 'Someone')}</span><b>${n}</b></li>`).join('')}</ul>` : '<p class="muted small-text">Nobody assigned yet.</p>'}
    </section>
    <section class="panel num-card"><h3 class="eyebrow">How they reached us</h3>
      <ul class="nrows"><li><span>Interest form</span><b>${list.filter((p) => p.source === 'form').length}</b></li><li><span>Added by a brother</span><b>${list.filter((p) => p.source === 'added').length}</b></li></ul>
    </section>
  </div>`;
}

// ---------- Events ----------

document.addEventListener('click', (e) => {
  if (!e.target.closest('#scene-recruit')) return;
  const t = e.target;
  const act = t.closest('[data-rec]')?.dataset.rec;
  if (act === 'qr') return openQr();
  if (act === 'new') return openPnmForm(null);
  const view = t.closest('[data-view]')?.dataset.view;
  if (view) { R.view = view; return renderRecruit(); }
  const filter = t.closest('[data-filter]')?.dataset.filter;
  if (filter) { R.filter = filter; return renderRecruit(); }
  const pill = t.closest('[data-stage-pill]')?.dataset.stagePill;
  if (pill) return $(`.rec-cols .col[data-stage="${pill}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  const card = t.closest('[data-pnm]');
  if (card) openPnm(card.dataset.pnm);
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('#scene-recruit [data-pnm]')) { e.preventDefault(); openPnm(e.target.dataset.pnm); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'rec-term') { R.term = e.target.value; renderRecruit(); }
  if (e.target.id === 'rec-stage') { R.stage = e.target.value; renderRecruit(); }
});
document.addEventListener('input', (e) => { if (e.target.id === 'rec-q') { R.q = e.target.value; renderRecruit(); } });

// ---------- A PNM's profile ----------

const telHref = (n) => String(n || '').replace(/[^0-9+]/g, '');
function socialLink(h) {
  const t = String(h || '').trim();
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  const m = t.match(/^@?([A-Za-z0-9._]{1,30})$/);
  return m ? `https://instagram.com/${m[1]}` : null;
}

export function openPnm(id) {
  if (!R.pnms.some((p) => p.id === id)) return toast("That PNM isn't here any more.");
  history.replaceState(null, '', `#recruit/${id}`);
  const s = openSheet({ title: 'PNM', onClose: () => { if (location.hash === `#recruit/${id}`) history.replaceState(null, '', '#recruit'); } });
  let how = 'text';

  const draw = () => {
    const p = R.pnms.find((x) => x.id === id);
    if (!p) { s.close(); return; }
    const f = facts(p);
    const log = logOf(id);
    const talkers = new Map();
    for (const l of log) if (l.kind === 'contact' && l.actor) talkers.set(l.actor, (talkers.get(l.actor) || 0) + 1);
    const social = socialLink(p.social);
    s.title(p.name);
    s.set(`<div class="fsec plain">
        <div class="profile-top">${photoHtml(p, 'lg')}<div><h3>${esc(p.name)}</h3>
          <div class="muted">${esc(p.term)} · ${p.source === 'form' ? 'Sent the interest form' : 'Added by a brother'} ${esc(fmtDate(p.created_at.slice(0, 10)))}</div></div></div>
        ${f.dup ? '<p class="flag">Possible duplicate: someone else this semester has the same email.</p>' : ''}
        ${field('Stage', `<select class="input" data-live="stage">${STAGES.map(([v, l]) => opt(v, l, p.stage)).join('')}</select>`)}
        <div class="btn-row">
          ${p.phone ? `<a class="btn small" href="tel:${esc(telHref(p.phone))}">Call</a><a class="btn small" href="sms:${esc(telHref(p.phone))}">Text</a>` : ''}
          ${p.email ? `<a class="btn small" href="mailto:${esc(p.email)}">Email</a>` : ''}
          ${social ? `<a class="btn small" href="${esc(social)}" target="_blank" rel="noopener noreferrer">${esc(p.social)}</a>` : ''}
        </div>
        ${p.contact_pref ? `<p class="muted small-text">Prefers ${esc(p.contact_pref)}.</p>` : ''}
      </div>
      <div class="fsec"><h3>Who's talking to him</h3>
        ${field('Main contact', `<select class="input" data-live="main_contact">${opt('', 'Nobody yet', p.main_contact || '')}${brothers().map((b) => opt(b.id, b.name, p.main_contact || '')).join('')}</select>`, p.met_by_text ? `On the form he named: ${p.met_by_text}` : '')}
        <p class="small-text" style="margin:0 0 .85rem">${talkers.size ? [...talkers.entries()].map(([a, n]) => `<span class="chip">${esc(profile(a)?.name || 'Someone')} · ${n}</span>`).join(' ') : '<span class="muted">No contacts logged yet.</span>'}</p>
      </div>
      <div class="fsec"><h3>Log a contact</h3>
        <div class="checks" role="radiogroup" aria-label="How">${HOW.map(([v, l]) => `<label class="check"><input type="radio" name="how" value="${v}"${v === how ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <div class="row-log">${field('Note (optional)', '<input class="input" name="contact_note" maxlength="1000" placeholder="Asked about the cookout">')}<button class="btn primary small" type="button" data-do="log">Log it</button></div>
      </div>
      <div class="fsec"><h3>Next step</h3>
        <div class="row2">${field('What', `<input class="input" name="next_step" maxlength="300" value="${esc(p.next_step || '')}" placeholder="Invite to the cookout">`)}${field('By', `<input class="input" name="next_date" type="date" value="${esc(p.next_date || '')}">`)}</div>
        <button class="btn small" type="button" data-do="next" style="margin-bottom:.85rem">Save next step</button>
      </div>
      <div class="fsec"><h3>Add a note</h3>
        ${field('Note', '<textarea class="input" name="note" maxlength="1000"></textarea>', 'Keep it factual. Write it as if he will read it.')}
        <button class="btn small" type="button" data-do="note" style="margin-bottom:.85rem">Save note</button>
      </div>
      <div class="fsec plain"><h3 class="eyebrow">About him</h3><dl class="kv">
        ${[['900 number', p.student_id], ['Phone', p.phone], ['Email', p.email], ['Major', p.major], ['Hobbies', p.hobbies], ['Social', p.social], ['Food allergies', p.allergies], ['Spoke with (form)', p.met_by_text]]
          .filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd class="prose">${esc(v)}</dd>`).join('') || '<dd class="muted">Nothing yet.</dd>'}
      </dl></div>
      <div class="fsec plain"><h3 class="eyebrow">History</h3><ul class="act">${[...log].reverse().map(historyLine).join('')}</ul></div>
      <div class="btn-row"><button class="btn" type="button" data-do="edit">Edit details</button><button class="btn danger" type="button" data-do="delete">Delete</button></div>
      <p class="muted small-text">PNM records are deleted automatically one year after they were entered.</p>`);
  };
  draw();

  const refresh = async () => { await loadRecruit(); if (!s.closed) draw(); };
  s.body.addEventListener('change', async (e) => {
    if (e.target.name === 'how') { how = e.target.value; return; }
    const live = e.target.dataset.live;
    if (!live) return;
    await write(sb.from('pnms').update({ [live]: e.target.value || null }).eq('id', id));
    toast(live === 'stage' ? `Moved to ${stageLabel(e.target.value)}.` : 'Main contact saved.');
    refresh();
  });
  s.body.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-do]')?.dataset.do;
    if (!act) return;
    const v = formData(s.body);
    if (act === 'log') {
      await write(sb.from('pnm_log').insert({ pnm_id: id, kind: 'contact', how, note: v.contact_note || null }));
      toast('Contact logged.');
      return refresh();
    }
    if (act === 'next') {
      await write(sb.from('pnms').update({ next_step: v.next_step || null, next_date: v.next_date || null }).eq('id', id));
      toast('Next step saved.');
      return refresh();
    }
    if (act === 'note') {
      if (!v.note) return toast('Write the note first.');
      await write(sb.from('pnm_log').insert({ pnm_id: id, kind: 'note', note: v.note }));
      toast('Note saved.');
      return refresh();
    }
    if (act === 'edit') return openPnmForm(R.pnms.find((x) => x.id === id), () => draw());
    if (act === 'delete') {
      const p = R.pnms.find((x) => x.id === id);
      if (!(await confirmSheet(`Delete ${p.name}?`, 'His record, notes, history and photo are removed for good.', 'Delete'))) return;
      if (p.photo_path) await sb.storage.from('pnm-photos').remove([p.photo_path]);
      await write(sb.from('pnms').delete().eq('id', id));
      s.close();
      toast('Deleted.');
      loadRecruit();
    }
  });
}

function historyLine(l) {
  const who = esc(profile(l.actor)?.name || (l.kind === 'created' ? 'The interest form' : 'Someone'));
  const when = esc(fmtStamp(l.at));
  if (l.kind === 'contact') return `<li><b>${who}</b> ${esc(l.how ? `logged a ${howLabel(l.how)}` : 'logged a contact')}${l.note ? `: “${esc(l.note)}”` : ''} · ${when}</li>`;
  if (l.kind === 'note') return `<li><b>${who}</b> noted: “${esc(l.note)}” · ${when}</li>`;
  if (l.kind === 'stage') return `<li><b>${who}</b> moved him: ${esc(l.note)} · ${when}</li>`;
  if (l.kind === 'assigned') return `<li><b>${who}</b> set the main contact to ${esc(l.note)} · ${when}</li>`;
  return `<li>${l.actor ? `<b>${who}</b> added him` : esc(l.note || 'Added')} · ${when}</li>`;
}

// ---------- Add / edit ----------

/** Shrink a photo to at most 900px on its long side, as a JPEG (drops location data). */
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const k = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("Couldn't read that photo."))), 'image/jpeg', 0.85));
}

export function openPnmForm(p, after) {
  const v = p || { term: R.term || termFor(new Date()) };
  let photo = null;
  const s = openSheet({
    title: p ? 'Edit PNM' : 'Add a PNM', primary: 'Save',
    html: `<div class="form-error" role="alert"></div>
      <div class="fsec">
        ${field('Name', `<input class="input" name="name" autocapitalize="words" maxlength="120" value="${esc(v.name || '')}" required>`)}
        ${field('Phone', `<input class="input" name="phone" type="tel" inputmode="tel" maxlength="30" value="${esc(v.phone || '')}">`)}
        ${p ? '' : '<p class="muted small-text">Name and phone are enough to start. Fill in the rest later.</p>'}
      </div>
      <div class="fsec"><h3>More</h3>
        ${field('Email', `<input class="input" name="email" type="email" inputmode="email" autocapitalize="none" maxlength="200" value="${esc(v.email || '')}">`)}
        ${field('Prefers', `<select class="input" name="contact_pref">${opt('', '—', v.contact_pref || '')}${opt('phone', 'Phone', v.contact_pref || '')}${opt('email', 'Email', v.contact_pref || '')}</select>`)}
        ${field('900 number', `<input class="input" name="student_id" inputmode="numeric" maxlength="11" value="${esc(v.student_id || '')}">`)}
        ${field('Major', `<input class="input" name="major" maxlength="120" value="${esc(v.major || '')}">`)}
        ${field('Hobbies', `<textarea class="input" name="hobbies" maxlength="2000">${esc(v.hobbies || '')}</textarea>`)}
        ${field('Social media', `<input class="input" name="social" autocapitalize="none" maxlength="120" value="${esc(v.social || '')}" placeholder="@handle">`)}
        ${field('Food allergies', `<input class="input" name="allergies" maxlength="300" value="${esc(v.allergies || '')}">`)}
        ${field('Semester', `<select class="input" name="term">${termChoices(v.term).map((t) => opt(t, t, v.term)).join('')}</select>`)}
        <div class="photo-pick"><span id="pnm-photo-prev">${p ? photoHtml(p, 'lg') : '<span class="av lg">?</span>'}</span>
          <label class="btn small">${v.photo_path ? 'Change photo' : 'Add a photo'}<input type="file" name="photo" accept="image/*"></label></div>
      </div>`,
    onPrimary: async () => {
      const f = formData(s.body);
      const sid = f.student_id.replace(/\D/g, '');
      if (!f.name) return s.error('Enter his name.');
      if (sid && !/^\d{9}$/.test(sid)) return s.error('A 900 number is 9 digits.');
      const row = { name: f.name, phone: f.phone || null, email: f.email || null, contact_pref: f.contact_pref || null, student_id: sid || null,
        major: f.major || null, hobbies: f.hobbies || null, social: f.social || null, allergies: f.allergies || null, term: f.term };
      let id = p?.id;
      if (p) await write(sb.from('pnms').update(row).eq('id', id));
      else id = (await write(sb.from('pnms').insert({ ...row, source: 'added' }).select('id').single())).id;
      if (photo) {
        const path = `${id}/${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}.jpg`;
        const up = await sb.storage.from('pnm-photos').upload(path, photo, { contentType: 'image/jpeg' });
        if (up.error) toast("Saved, but the photo didn't upload.");
        else {
          if (p?.photo_path) sb.storage.from('pnm-photos').remove([p.photo_path]);
          await write(sb.from('pnms').update({ photo_path: path }).eq('id', id));
        }
      }
      await loadRecruit();
      if (row.term !== R.term && !p) { R.term = row.term; renderRecruit(); }
      s.close();
      toast(p ? 'Saved.' : `${f.name} added.`);
      if (after) after(); else if (!p) openPnm(id);
    },
  });
  s.body.querySelector('[name="photo"]').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try { photo = await shrink(file); $('#pnm-photo-prev', s.body).innerHTML = `<span class="av lg"><img src="${URL.createObjectURL(photo)}" alt=""></span>`; }
    catch (err) { photo = null; s.error(err.message); }
  });
  setTimeout(() => $('[name="name"]', s.body)?.focus(), 50);
}

// ---------- Interest form QR ----------

function loadQrLib() {
  if (window.qrcode) return Promise.resolve();
  return new Promise((ok, no) => {
    const el = document.createElement('script');
    el.src = 'app/vendor/qrcode.js';
    el.onload = ok; el.onerror = () => no(new Error("Couldn't load the QR code."));
    document.body.appendChild(el);
  });
}

export async function openQr() {
  const url = new URL('../Interest/', location.href).href;
  const shown = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const s = openSheet({ title: 'Interest form', html: '<p class="empty">Loading…</p>' });
  try {
    await loadQrLib();
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    s.set(`<div class="qr-box">
      <div class="qr" role="img" aria-label="QR code for ${esc(shown)}">${qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true })}</div>
      <p class="qr-url">${esc(shown)}</p>
      <p class="muted small-text">Point a phone camera at the code. New answers show up here as "Interested" in ${esc(termFor(new Date()))}.</p>
      <div class="btn-row" style="justify-content:center"><button class="btn" type="button" data-do="copy">Copy link</button><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open the form</a></div>
    </div>`);
    s.body.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-do="copy"]')) return;
      try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { toast(url); }
    });
  } catch (err) {
    s.set(`<p class="app-note">${esc(err.message)} The form is at ${esc(shown)}.</p>`);
  }
}
