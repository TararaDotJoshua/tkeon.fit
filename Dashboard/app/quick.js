// The Quick access tab: big buttons for things brothers reach for often.
//  - Org chart: who holds each position and committee (public, like positions already are).
//  - Study hours: each brother logs his own, by hand or with a timer. He sees only
//    his own; admins also see the whole chapter. The database enforces both.

import { $, DAY, confirmSheet, esc, field, fmtDate, formData, openSheet, toast, today, ymd } from './ui.js';
import { S, sb, avatar, isAdmin, isMember, profile, write } from './store.js';
import { asMember } from './auth.js';
import { loadOpenNow, openCheckin, openNow } from './checkin.js';

const D = window.DASH;
const TIMER_KEY = 'tkeon-study-timer';
const Q = { rows: [], loadedFor: null, loading: null };

// ---------- Dates ----------

/** Spring is January to May; Fall is June to December (same as Recruitment). */
export function semesterOf(d = today()) {
  const spring = d.getMonth() < 5;
  return { label: `${spring ? 'Spring' : 'Fall'} ${d.getFullYear()}`, start: new Date(d.getFullYear(), spring ? 0 : 5, 1) };
}
/** Monday of this week. */
const weekStart = (d = today()) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
const hours = (min) => {
  const h = Math.round((min / 60) * 10) / 10;
  return `${h.toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
};
const sum = (rows) => rows.reduce((n, r) => n + r.minutes, 0);

// ---------- Study hours data ----------

/** Load this semester's study hours: your own, or everyone's for an admin. */
export function loadStudy() {
  if (!isMember()) { Q.rows = []; Q.loadedFor = null; return Promise.resolve(); }
  Q.loading ||= (async () => {
    try {
      const { data, error } = await sb.from('study_hours').select('*').gte('day', ymd(semesterOf().start)).order('day', { ascending: false }).order('created_at', { ascending: false });
      if (error) throw error;
      Q.rows = data;
      Q.loadedFor = S.user.id;
    } catch (e) {
      console.error(e);
    } finally {
      Q.loading = null;
      if (D.scene() === 'quick') renderQuick();
    }
  })();
  return Q.loading;
}
export const resetStudy = () => { Q.rows = []; Q.loadedFor = null; };
const mine = () => Q.rows.filter((r) => r.profile_id === S.user?.id);
const totals = (rows) => {
  const w = ymd(weekStart());
  return { week: sum(rows.filter((r) => r.day >= w)), semester: sum(rows) };
};

// ---------- Study timer (kept on this phone, survives closing the app) ----------

function readTimer() {
  try {
    const t = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null');
    return t && t.uid === S.user?.id && Number.isFinite(t.start) ? t : null;
  } catch { return null; }
}
function writeTimer(t) {
  try { if (t) localStorage.setItem(TIMER_KEY, JSON.stringify(t)); else localStorage.removeItem(TIMER_KEY); } catch { /* private browsing: the timer just won't survive a reload */ }
}
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ---------- The tab ----------

const ICONS = {
  org: '<rect x="9" y="2.5" width="6" height="5" rx="1"/><rect x="2.5" y="16.5" width="6" height="5" rx="1"/><rect x="9" y="16.5" width="6" height="5" rx="1"/><rect x="15.5" y="16.5" width="6" height="5" rx="1"/><path d="M12 7.5v4.5M5.5 16.5V12h13v4.5M12 12v4.5"/>',
  checkin: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M8.5 15.5l2.4 2.4 4.6-4.8"/>',
  study: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5M8 7h8M8 11h6"/>',
};
const tile = (id, title, sub) => `<button class="panel qtile" type="button" data-quick="${id}">
    <span class="qico"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]}</svg></span>
    <span class="qtext"><span class="qtitle">${esc(title)}</span><span class="qsub">${sub}</span></span>
    <span class="chev" aria-hidden="true">›</span>
  </button>`;

let tileTick = 0, openChecked = 0;
export function renderQuick() {
  const el = $('#scene-quick');
  if (!el || el.hidden) return;
  if (isMember() && Q.loadedFor !== S.user.id && !Q.loading) loadStudy();
  const positions = S.teams.filter((t) => !t.archived_at && t.kind === 'position');
  const filled = positions.filter((t) => holders(t.id).length).length;
  const timer = isMember() ? readTimer() : null;
  let studySub;
  if (!isMember()) studySub = 'Sign in to log your hours';
  else if (timer) studySub = `<b class="q-live">Timer running · <span data-clock>${clock(Date.now() - timer.start)}</span></b>`;
  else if (Q.loadedFor !== S.user.id) studySub = 'Loading…';
  else { const t = totals(mine()); studySub = `This week ${hours(t.week)} · ${esc(semesterOf().label)} ${hours(t.semester)}`; }

  // Events with check-in open right now (refreshed when the tab is drawn, at most every 20 s).
  if (isMember() && Date.now() - openChecked > 20e3) { openChecked = Date.now(); loadOpenNow(true).then(() => { if (D.scene() === 'quick') renderQuick(); }); }
  const open = isMember() ? openNow() : [];
  const checkinSub = !isMember() ? 'Sign in to check in to events'
    : open.length ? `<b class="q-live">Check-in open · ${esc(open[0].title)}${open.length > 1 ? ` + ${open.length - 1} more` : ''}</b>`
    : 'Check in at chapter events';

  el.innerHTML = `<div class="app-head"><h2>Quick access</h2></div>
    <div class="quick-grid">
      ${tile('checkin', 'Event check-in', checkinSub)}
      ${tile('org', 'Org chart', S.loaded ? `${filled} of ${positions.length} positions filled` : 'Loading…')}
      ${tile('study', 'Study hours', studySub)}
    </div>`;
  clearInterval(tileTick);
  if (timer) tileTick = setInterval(() => { const c = $('#scene-quick [data-clock]'); if (!c || $('#scene-quick').hidden) return clearInterval(tileTick); c.textContent = clock(Date.now() - timer.start); }, 1000);
}

document.addEventListener('click', (e) => {
  const go = e.target.closest('#scene-quick [data-quick]')?.dataset.quick;
  if (go === 'org') openOrgChart();
  if (go === 'study') asMember(openStudy);
  if (go === 'checkin') asMember(() => openCheckin());
});

// ---------- Org chart ----------

const holders = (teamId) => S.profileTeams.filter((x) => x.team_id === teamId).map((x) => profile(x.profile_id))
  .filter((p) => p && !p.disabled).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
/** "Prytanis (President)" -> title "Prytanis", role "President". */
const titleOf = (name) => { const m = /^(.+?)\s*\((.+)\)\s*$/.exec(name); return m ? { title: m[1], role: m[2] } : { title: name, role: '' }; };
const yr = (p) => (p.grad_year ? ` <span class="oc-yr">’${String(p.grad_year).slice(-2)}</span>` : '');

function ocCard(t, big = false) {
  const { title, role } = titleOf(t.name);
  const people = holders(t.id);
  return `<div class="oc-card${big ? ' oc-head' : ''}${people.length ? '' : ' is-open'}">
    <div class="oc-title">${esc(title)}</div>${role ? `<div class="oc-role">${esc(role)}</div>` : ''}
    <div class="oc-people">${people.map((p) => `<span class="oc-person">${avatar(p, big ? '' : 'sm')}<span class="oc-name">${esc(p.name || 'No name yet')}${yr(p)}</span></span>`).join('') || '<span class="oc-open">Open</span>'}</div>
  </div>`;
}

export function openOrgChart() {
  const live = S.teams.filter((t) => !t.archived_at);
  const tier = (name) => live.filter((t) => t.kind === 'position' && (t.chart || 'chair') === name);
  const head = tier('head'), exec = tier('exec'), chairs = tier('chair');
  const committees = live.filter((t) => t.kind === 'committee');
  const group = (label, list) => (list.length ? `<section class="oc-tier"><h3 class="eyebrow oc-label">${label}</h3><div class="oc-grid">${list.map((t) => ocCard(t)).join('')}</div></section>` : '');
  const html = live.length
    ? `${head.length ? `<section class="oc-tier oc-top">${head.map((t) => ocCard(t, true)).join('')}</section>` : ''}
       ${group('Executive board', exec)}
       ${group('Chairmen', chairs)}
       ${group('Committees', committees)}
       ${isAdmin() ? '<p class="muted small-text oc-note">Admins: give brothers positions in Settings › Members. Move a position between the top, the executive board and the chairmen in Settings › Positions and committees.</p>' : ''}`
    : '<p class="empty">No positions yet. An admin adds them in Settings.</p>';
  openSheet({ title: 'Org chart', html: `<div class="org">${html}</div>` });
}

// ---------- Study hours ----------

export function openStudy() {
  if (!isMember()) return;
  let tick = 0;
  const s = openSheet({
    title: 'Study hours', primary: 'Save',
    onPrimary: async () => {
      const f = formData(s.body);
      const h = Number(f.hours);
      if (!Number.isFinite(h) || h < 0.1 || h > 24) return s.error('Enter the hours you studied, like 1.5.');
      const minDay = ymd(new Date(today() - 30 * DAY)), maxDay = ymd(today());
      if (!f.day || f.day > maxDay || f.day < minDay) return s.error('Pick today or a day in the last 30 days.');
      const minutes = Math.round(h * 60);
      await write(sb.from('study_hours').insert({ day: f.day, minutes, place: f.place || null, note: f.note || null }));
      if (s.fromTimer) writeTimer(null);
      await loadStudy();
      toast(`Logged ${hours(minutes)}.`);
      draw({});
    },
    onClose: () => { clearInterval(tick); renderQuick(); },
  });

  function draw(keep) {
    const t = totals(mine());
    const timer = readTimer();
    const places = [...new Set(mine().map((r) => r.place).filter(Boolean))].slice(0, 8);
    const recent = mine().slice(0, 15);
    s.fromTimer = Boolean(keep.fromTimer);
    s.set(`<div class="form-error" role="alert"></div>
      <div class="st-totals">
        <div class="panel st-box"><span class="eyebrow">This week</span><b>${hours(t.week)}</b></div>
        <div class="panel st-box"><span class="eyebrow">${esc(semesterOf().label)}</span><b>${hours(t.semester)}</b></div>
      </div>
      <div class="fsec plain st-timer">
        ${timer
          ? `<div class="st-clock" data-clock>${clock(Date.now() - timer.start)}</div>
             <p class="muted small-text">Started ${new Date(timer.start).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}. It keeps running if you close the app.</p>
             <div class="btn-row"><button class="btn primary" type="button" data-st="stop">Stop and fill in</button><button class="btn quiet" type="button" data-st="discard">Discard</button></div>`
          : `<button class="btn block" type="button" data-st="start">Start a study timer</button>
             <p class="muted small-text">Tap it when you sit down to study. Stop it when you're done and it fills in the hours below.</p>`}
      </div>
      <div class="fsec">
        <h3>Log study time</h3>
        <div class="row2">
          ${field('Hours', `<input class="input" name="hours" type="number" inputmode="decimal" min="0.1" max="24" step="0.25" placeholder="1.5" value="${esc(keep.hours ?? '')}" required>`)}
          ${field('Day', `<input class="input" name="day" type="date" min="${ymd(new Date(today() - 30 * DAY))}" max="${ymd(today())}" value="${esc(keep.day || ymd(today()))}" required>`)}
        </div>
        ${field('Where (optional)', `<input class="input" name="place" maxlength="80" list="st-places" placeholder="Evans Library" value="${esc(keep.place ?? '')}"><datalist id="st-places">${places.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>`)}
        ${field('What (optional)', `<input class="input" name="note" maxlength="300" placeholder="Calc 2 exam prep" value="${esc(keep.note ?? '')}">`)}
      </div>
      <div class="fsec plain">
        <h3>Your hours this semester</h3>
        ${recent.length ? `<ul class="rows">${recent.map((r) => `<li class="rowi"><span class="rowi-main"><span class="rowi-title">${hours(r.minutes)} · ${esc(fmtDate(r.day))}</span>${r.place || r.note ? `<span class="rowi-sub">${esc([r.place, r.note].filter(Boolean).join(' · '))}</span>` : ''}</span><button class="btn quiet small" type="button" data-del="${r.id}" aria-label="Delete ${hours(r.minutes)} on ${esc(fmtDate(r.day))}">Delete</button></li>`).join('')}</ul>` : '<p class="muted small-text">Nothing logged yet this semester.</p>'}
      </div>
      ${isAdmin() ? chapterTable() : ''}`);
    clearInterval(tick);
    if (timer) tick = setInterval(() => { const c = $('[data-clock]', s.body); if (c) c.textContent = clock(Date.now() - timer.start); }, 1000);
  }

  s.body.addEventListener('click', async (e) => {
    const st = e.target.closest('[data-st]')?.dataset.st;
    const keep = () => ({ ...formData(s.body), fromTimer: s.fromTimer });
    if (st === 'start') { writeTimer({ uid: S.user.id, start: Date.now() }); draw(keep()); toast('Timer started.'); }
    if (st === 'discard') {
      if (!(await confirmSheet('Discard the timer?', 'The time on it is not logged.', 'Discard'))) return;
      writeTimer(null); draw(keep());
    }
    if (st === 'stop') {
      const timer = readTimer();
      if (!timer) return draw(keep());
      const h = Math.min(24, Math.max(0.1, Math.round(((Date.now() - timer.start) / 3600e3) * 4) / 4 || 0.1));
      draw({ ...keep(), hours: String(h), day: ymd(new Date(timer.start)) < ymd(new Date(today() - 30 * DAY)) ? ymd(today()) : ymd(new Date(timer.start)), fromTimer: true });
      $('[name="hours"]', s.body)?.focus();
      toast('Check the hours, then tap Save.');
    }
    const del = e.target.closest('[data-del]')?.dataset.del;
    if (del) {
      if (!(await confirmSheet('Delete this entry?', 'It comes off your study hours.', 'Delete'))) return;
      await write(sb.from('study_hours').delete().eq('id', del));
      await loadStudy();
      draw(keep());
    }
  });

  draw({});
  if (Q.loadedFor !== S.user.id) loadStudy().then(() => { if (!s.closed) draw({ ...formData(s.body), fromTimer: s.fromTimer }); });
}

/** Admins: every active brother's hours this week and this semester, fewest this week first. */
function chapterTable() {
  const w = ymd(weekStart());
  const people = S.profiles.filter((p) => !p.disabled).map((p) => {
    const rows = Q.rows.filter((r) => r.profile_id === p.id);
    return { p, week: sum(rows.filter((r) => r.day >= w)), semester: sum(rows) };
  }).sort((a, b) => a.week - b.week || (a.p.name || '').localeCompare(b.p.name || ''));
  return `<div class="fsec plain">
    <h3>The chapter · admins only</h3>
    <ul class="rows st-chapter">${people.map((x) => `<li class="rowi">${avatar(x.p, 'sm')}<span class="rowi-main"><span class="rowi-title">${esc(x.p.name || 'No name yet')}</span></span><span class="st-num"><b>${hours(x.week)}</b><span class="muted">week</span></span><span class="st-num"><b>${hours(x.semester)}</b><span class="muted">sem.</span></span></li>`).join('') || '<li class="muted small-text">Nobody has signed in yet.</li>'}</ul>
  </div>`;
}
