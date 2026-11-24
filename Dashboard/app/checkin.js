// Event check-in.
//  - Officers (an admin, or anyone holding a position) start check-in from an
//    event in This week. The app shows a random 4-character code.
//  - Brothers open Quick access > Event check-in. At an event with "Must be here"
//    on (the default) they tap Check in here: the phone's location is checked
//    once against where check-in was started, and never saved. No code needed.
//    At an online event (Must be here off) they type the code.
//  - Officers see attendance from the event, and past events from This week.
// The database checks all of it (supabase/checkin.sql); these are the screens.

import { $, confirmSheet, esc, friendly, openSheet, toast } from './ui.js';
import { S, sb, avatar, isAdmin, isMember, load as loadStore, onChange, profile } from './store.js';
import { asMember } from './auth.js';

const D = window.DASH;
const C = { open: [], openFor: null, openAt: 0 }; // events with check-in open right now

// ---------- Helpers ----------

export const isOfficer = () => isMember() && (isAdmin() || S.profileTeams.some((x) => x.profile_id === S.user.id
  && S.teams.some((t) => t.id === x.team_id && t.kind === 'position' && !t.archived_at)));

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data;
}
const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const when = (e) => (e.all_day ? `${day(e.starts_at.slice(0, 10) + 'T12:00:00')} · all day` : `${day(e.starts_at)} · ${time(e.starts_at)}`);

const WHY = {
  bad_code: "That code isn't open right now. Check it and try again.",
  too_many_tries: 'Too many wrong codes. Wait 15 minutes, or ask an officer to add you.',
  need_location: "This event checks that you're there, so it needs your location. Allow location for this site and try again.",
  location_vague: "Your phone couldn't tell where you are closely enough. Step near a window or outside and try again, or ask an officer to add you.",
  geo_denied: 'Location is blocked for this site. Allow it in your phone settings (on an iPhone: Settings › Privacy & Security › Location Services › Safari Websites), then try again, or ask an officer to add you.',
  geo_failed: "Couldn't get your location. Try again, or ask an officer to add you.",
  no_geo: "This browser can't share its location. Ask an officer to add you.",
  officers_only: 'Only officers and chairmen can do that.',
  too_early: 'Check-in can start up to 3 hours before the event.',
  event_over: 'This event is over. You can still add brothers from its attendance.',
  not_open: 'Check-in for this event is closed.',
  members_only: 'Sign in first.',
  no_event: "That event isn't on the calendar anymore.",
  none_open: "No event near you has check-in open. If it's an online event, type the code instead.",
};
function why(err) {
  const m = String(err?.message || err || '');
  const far = /too_far:(\d+)/.exec(m);
  if (far) return `You seem to be about ${Number(far[1]).toLocaleString('en-US')} m from where check-in was started. If you're at the event, ask an officer to add you.`;
  const k = Object.keys(WHY).find((key) => m.includes(key));
  return k ? WHY[k] : friendly(err);
}

/** This phone's location, once. */
function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no_geo'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'geo_denied' : 'geo_failed')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

function download(name, rows) {
  const csv = rows.map((r) => r.map((v) => {
    const t = String(v ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  }).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const HOW = { code: 'Code', here: 'At the event', added: 'Added by an officer' };
const fileName = (title, iso) => `${String(title).replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'event'}-${iso.slice(0, 10)}.csv`;

// Semesters: Spring is January to May, Fall June to December (as elsewhere).
function semesters(n = 4) {
  const out = [];
  let d = new Date();
  for (let i = 0; i < n; i++) {
    const spring = d.getMonth() < 5, y = d.getFullYear();
    const start = new Date(y, spring ? 0 : 5, 1), end = spring ? new Date(y, 5, 1) : new Date(y + 1, 0, 1);
    out.push({ label: `${spring ? 'Spring' : 'Fall'} ${y}`, start, end });
    d = new Date(start.getTime() - 864e5);
  }
  return out;
}

// ---------- Events with check-in open (brothers' tile and screen) ----------

export async function loadOpenNow(force = false) {
  if (!isMember()) { C.open = []; C.openFor = null; return C.open; }
  if (!force && C.openFor === S.user.id && Date.now() - C.openAt < 15e3) return C.open;
  try { C.open = await rpc('checkin_open_now'); C.openFor = S.user.id; C.openAt = Date.now(); } catch (e) { console.error(e); }
  return C.open;
}
export const openNow = () => (C.openFor === S.user?.id ? C.open : []);

// ---------- In the event details (This week) ----------

// Resolves once sign-in and the member list have loaded (the popup can open before that).
const loaded = () => (S.loaded ? Promise.resolve() : new Promise((resolve) => onChange(() => { if (S.loaded) resolve(); })));

D.eventExtra = (e, pop) => {
  if (!e?.id) return;
  const box = document.createElement('div');
  box.className = 'pop-row ci-box';
  box.innerHTML = '<div class="eyebrow">Check-in</div><p class="ci-line muted">Loading…</p>';
  pop.appendChild(box);
  loaded().then(() => {
    if (!isMember()) return box.remove(); // visitors see no check-in
    return (isOfficer() ? officerBox : brotherBox)(e, box);
  }).catch((err) => { $('.ci-line', box).textContent = why(err); });
};

async function officerBox(e, box) {
  const st = await rpc('checkin_status', { p_event: e.id });
  const now = Date.now(), s = Date.parse(e.starts_at), en = Date.parse(e.ends_at);
  const canStart = now >= s - 3 * 3600e3 && now <= en;
  let line, main = '';
  if (st.open) {
    line = `Open until ${time(st.closes_at)} · ${st.count} checked in${st.need_location ? '' : ' · no location check'}`;
    main = '<button class="btn primary" type="button" data-ci="code">Show the code</button>';
  } else if (canStart) {
    line = st.opened_at ? `Closed · ${st.count} checked in` : 'Not started yet.';
    main = `<button class="btn primary" type="button" data-ci="start">${st.opened_at ? 'Reopen check-in' : 'Start check-in'}</button>`;
  } else if (now < s) {
    line = 'You can start check-in from 3 hours before it begins.';
  } else {
    line = `${st.count} checked in`;
  }
  box.innerHTML = `<div class="eyebrow">Check-in</div><p class="ci-line">${esc(line)}</p>
    <div class="btn-row">${main}<button class="btn" type="button" data-ci="attendance">Attendance</button></div>`;
  box.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-ci]')?.dataset.ci;
    if (!act) return;
    D.closeEvent();
    if (act === 'start') openStart(e);
    if (act === 'code') openCode(e);
    if (act === 'attendance') openAttendance(e.id);
  });
}

async function brotherBox(e, box) {
  const [open, mine] = await Promise.all([
    loadOpenNow(true),
    sb.from('attendance').select('checked_in_at').eq('event_id', e.id).eq('profile_id', S.user.id).maybeSingle(),
  ]);
  if (mine.data) {
    box.innerHTML = `<div class="eyebrow">Check-in</div><p class="ci-line ci-done">✓ You checked in at ${esc(time(mine.data.checked_in_at))}.</p>`;
  } else if (open.some((x) => x.event_id === e.id)) {
    const here = open.find((x) => x.event_id === e.id).need_location;
    box.innerHTML = `<div class="eyebrow">Check-in</div><p class="ci-line">${here ? "Check-in is open. If you're there, tap Check in here." : 'Check-in is open. Get the code from an officer.'}</p>
      <div class="btn-row"><button class="btn primary" type="button" data-ci="checkin">${here ? 'Check in here' : 'Check in'}</button></div>`;
    $('[data-ci="checkin"]', box).addEventListener('click', () => { D.closeEvent(); openCheckin('', here ? { here: e.id } : {}); });
  } else {
    box.remove(); // nothing to say
  }
}

// ---------- Officer: start check-in, the code screen ----------

function openStart(e) {
  const s = openSheet({
    title: 'Start check-in', primary: 'Start', small: true,
    html: `<div class="form-error" role="alert"></div>
      <p class="ci-event"><b>${esc(e.title)}</b><br><span class="muted">${esc(when(e))}</span></p>
      <div class="fsec">
        <label class="switch"><span>Must be here</span><input type="checkbox" name="need_location" checked></label>
        <p class="hint" style="margin:-0.3rem 0 0.9rem">Brothers within about 150 m of where your phone is now just tap Check in here, no code needed. Turn this off for an online event; then they type the code. Uses your location once, now.</p>
      </div>
      <p class="muted small-text">You also get a 4-character code. With Must be here on, it still needs the brother's location; it's for online events, with Must be here off. Anyone whose location won't work, add from Attendance. Check-in closes 30 minutes after the event ends.</p>`,
    onPrimary: async () => {
      const need = $('[name="need_location"]', s.body).checked;
      let at = {};
      if (need) {
        try { at = await locate(); } catch (err) { return s.error(why(err) + ' Or turn off Must be here.'); }
        if (at.accuracy > 1000) return s.error(`Your phone only knows where you are to within ${Math.round(at.accuracy)} m. Step near a window and try again, or turn off Must be here.`);
      }
      try {
        await rpc('checkin_start', { p_event: e.id, p_need_location: need, p_lat: at.lat ?? null, p_lng: at.lng ?? null, p_accuracy: at.accuracy ?? null });
      } catch (err) { return s.error(why(err)); }
      s.close();
      openCode(e);
    },
  });
}

function openCode(e) {
  let st = null, timer = 0;
  const s = openSheet({ title: 'Check-in', onClose: () => clearInterval(timer) });
  const draw = () => {
    if (s.closed || !st) return;
    if (!st.open) {
      s.set(`<div class="ci-code-box"><p class="ci-event"><b>${esc(e.title)}</b></p><p class="ci-line">Check-in is closed. ${st.count} checked in.</p>
        <div class="btn-row center"><button class="btn" type="button" data-ci="attendance">Attendance</button></div></div>`);
      clearInterval(timer);
      return;
    }
    s.set(`<div class="form-error" role="alert"></div>
      <div class="ci-code-box">
        <p class="ci-event"><b>${esc(e.title)}</b><br><span class="muted">${esc(when(e))}</span></p>
        <p class="eyebrow">Check-in code</p>
        <div class="ci-code" aria-label="Code ${esc(st.code.split('').join(' '))}">${esc(st.code)}</div>
        <p class="ci-how">${st.need_location ? 'At the event: Quick access › <b>Event check-in</b> › <b>Check in here</b>. No code needed.' : 'Quick access › <b>Event check-in</b> › type the code › <b>Check in</b>'}</p>
        <p class="ci-count"><b>${st.count}</b> checked in</p>
        <p class="muted small-text">Open until ${esc(time(st.closes_at))} · ${st.need_location ? 'Must be here: on' : 'Must be here: off'}</p>
      </div>
      <div class="btn-row center">
        <button class="btn" type="button" data-ci="attendance">Attendance</button>
        <button class="btn" type="button" data-ci="new_code">New code</button>
        <button class="btn" type="button" data-ci="${st.need_location ? 'location_off' : 'location_on'}">${st.need_location ? 'Turn off Must be here' : 'Turn on Must be here'}</button>
        <button class="btn danger" type="button" data-ci="close">Close check-in</button>
      </div>`);
  };
  const refresh = async () => { try { st = await rpc('checkin_status', { p_event: e.id }); draw(); } catch (err) { s.error(why(err)); } };
  s.body.addEventListener('click', async (ev) => {
    const act = ev.target.closest('[data-ci]')?.dataset.ci;
    if (!act) return;
    if (act === 'attendance') return openAttendance(e.id);
    if (act === 'new_code' && !(await confirmSheet('Make a new code?', 'The old code stops working right away. Brothers already checked in stay checked in.', 'New code'))) return;
    if (act === 'close' && !(await confirmSheet('Close check-in?', 'Nobody else can check in with the code. You can still add brothers from Attendance.', 'Close'))) return;
    let at = {};
    if (act === 'location_on') {
      try { at = await locate(); } catch (err) { return s.error(why(err)); }
    }
    try {
      st = await rpc('checkin_change', { p_event: e.id, p_action: act, p_lat: at.lat ?? null, p_lng: at.lng ?? null, p_accuracy: at.accuracy ?? null });
      draw();
      if (act === 'new_code') toast('New code. The old one no longer works.');
    } catch (err) { s.error(why(err)); }
  });
  s.set('<p class="empty">Loading…</p>');
  refresh();
  timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000); // the count, and changes another officer makes
}

// ---------- Officer: attendance for one event ----------

export async function openAttendance(eventId) {
  const s = openSheet({ title: 'Attendance', html: '<p class="empty">Loading…</p>' });
  let ev = null, rows = [];
  const load = async () => {
    const [e, a] = await Promise.all([
      sb.from('event_history').select('*').eq('id', eventId).maybeSingle(),
      sb.from('attendance').select('*').eq('event_id', eventId).order('checked_in_at'),
      loadStore(), // brothers who joined since the app opened
    ]);
    if (a.error) throw a.error;
    ev = e.data || (D.data()?.events || []).find((x) => x.id === eventId) || { id: eventId, title: 'Event', starts_at: new Date().toISOString() };
    rows = a.data;
  };
  const draw = () => {
    if (s.closed) return;
    const here = new Set(rows.map((r) => r.profile_id));
    const members = S.profiles.filter((p) => !p.disabled && !p.is_advisor);
    const away = members.filter((p) => !here.has(p.id));
    s.set(`<div class="form-error" role="alert"></div>
      <p class="ci-event"><b>${esc(ev.title)}</b><br><span class="muted">${esc(when(ev))}</span></p>
      <p class="ci-count"><b>${rows.filter((r) => !profile(r.profile_id)?.is_advisor).length}</b> of ${members.length} brothers checked in</p>
      <div class="fsec plain"><h3>Checked in</h3>
        ${rows.length ? `<ul class="rows">${rows.map((r) => { const p = profile(r.profile_id); const by = r.method === 'added' ? ` · added by ${esc(profile(r.added_by)?.name || 'an officer')}` : r.method === 'here' ? ' · at the event' : ' · with the code'; return `<li class="rowi">${avatar(p, 'sm')}<span class="rowi-main"><span class="rowi-title">${esc(p?.name || 'Former member')}</span><span class="rowi-sub">${esc(time(r.checked_in_at))}${by}</span></span><button class="btn quiet small" type="button" data-rm="${r.profile_id}">Remove</button></li>`; }).join('')}</ul>` : '<p class="muted small-text">Nobody yet.</p>'}
      </div>
      <div class="fsec plain"><h3>Not checked in</h3>
        ${away.length ? `<ul class="rows">${away.map((p) => `<li class="rowi">${avatar(p, 'sm')}<span class="rowi-main"><span class="rowi-title">${esc(p.name || 'No name yet')}</span></span><button class="btn small" type="button" data-add="${p.id}">Add</button></li>`).join('')}</ul>` : '<p class="muted small-text">Everyone is here.</p>'}
      </div>
      <button class="btn block" type="button" data-csv>Download as a spreadsheet (CSV)</button>`);
  };
  s.body.addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add]')?.dataset.add, rm = e.target.closest('[data-rm]')?.dataset.rm;
    try {
      if (add) { await rpc('attendance_add', { p_event: eventId, p_profile: add }); toast(`Added ${profile(add)?.name || 'him'}.`); }
      if (rm) {
        if (!(await confirmSheet('Remove this check-in?', `${profile(rm)?.name || 'He'} will show as not checked in.`, 'Remove'))) return;
        await rpc('attendance_remove', { p_event: eventId, p_profile: rm });
      }
      if (add || rm) { await load(); draw(); }
    } catch (err) { s.error(why(err)); }
    if (e.target.closest('[data-csv]')) {
      const here = new Map(rows.map((r) => [r.profile_id, r]));
      download(fileName(ev.title, ev.starts_at), [['Name', 'Class of', 'Checked in', 'Time', 'How'],
        ...S.profiles.filter((p) => (!p.disabled && !p.is_advisor) || here.has(p.id)).map((p) => { const r = here.get(p.id); return [p.name, p.grad_year, r ? 'Yes' : 'No', r ? new Date(r.checked_in_at).toLocaleString('en-US') : '', r ? (r.method === 'added' ? `Added by ${profile(r.added_by)?.name || 'an officer'}` : HOW[r.method] || r.method) : '']; })]);
    }
  });
  try { await load(); draw(); } catch (err) { s.set(`<p class="empty">${esc(why(err))}</p>`); }
}

// ---------- Officer: past events (button on This week) ----------

export function openPast() {
  const terms = semesters();
  let term = terms[0];
  const s = openSheet({ title: 'Past events', html: '<p class="empty">Loading…</p>' });
  let events = [], counts = new Map();
  const load = async () => {
    await loadStore(); // names of brothers who joined since the app opened
    const upto = new Date(Math.min(Date.now(), term.end.getTime())).toISOString();
    const { data, error } = await sb.from('event_history').select('*').gte('starts_at', term.start.toISOString()).lt('starts_at', upto).order('starts_at', { ascending: false });
    if (error) throw error;
    counts = new Map();
    for (let i = 0; i < data.length; i += 150) {
      const { data: a, error: e2 } = await sb.from('attendance').select('event_id, profile_id').in('event_id', data.slice(i, i + 150).map((x) => x.id));
      if (e2) throw e2;
      a.forEach((r) => counts.set(r.event_id, (counts.get(r.event_id) || 0) + 1));
    }
    events = data.filter((x) => !x.removed_at || counts.get(x.id));
  };
  const draw = () => {
    if (s.closed) return;
    s.set(`<div class="form-error" role="alert"></div>
      <div class="rec-bar"><select class="mini" data-term aria-label="Semester">${terms.map((t, i) => `<option value="${i}"${t === term ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
        <span class="muted small-text">${events.length} event${events.length === 1 ? '' : 's'}</span></div>
      ${events.length ? `<div class="fsec plain ci-past"><ul class="rows">${events.map((x) => { const n = counts.get(x.id) || 0; return `<li><button class="rowi" type="button" data-ev="${esc(x.id)}"><span class="rowi-main"><span class="rowi-title">${esc(x.title)}</span><span class="rowi-sub">${esc(when(x))}</span></span><span class="ci-n${n ? '' : ' muted'}">${n ? `${n} checked in` : 'No check-in'}</span><span class="chev" aria-hidden="true">›</span></button></li>`; }).join('')}</ul></div>` : '<p class="muted">No past events this semester yet. Events are kept from when this feature started.</p>'}
      ${events.some((x) => counts.get(x.id)) ? '<button class="btn block" type="button" data-csv>Download the semester as a spreadsheet (CSV)</button>' : ''}`);
  };
  s.body.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-term]')) return;
    term = terms[Number(e.target.value)];
    s.set('<p class="empty">Loading…</p>');
    try { await load(); draw(); } catch (err) { s.error(why(err)); }
  });
  s.body.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-ev]')?.dataset.ev;
    if (id) return openAttendance(id);
    if (e.target.closest('[data-csv]')) {
      try {
        const ids = events.filter((x) => counts.get(x.id)).map((x) => x.id);
        const rows = [];
        for (let i = 0; i < ids.length; i += 150) {
          const { data, error } = await sb.from('attendance').select('*').in('event_id', ids.slice(i, i + 150));
          if (error) throw error;
          rows.push(...data);
        }
        const byId = new Map(events.map((x) => [x.id, x]));
        rows.sort((a, b) => byId.get(a.event_id).starts_at.localeCompare(byId.get(b.event_id).starts_at) || (profile(a.profile_id)?.name || '').localeCompare(profile(b.profile_id)?.name || ''));
        download(`attendance-${term.label.replace(' ', '-')}.csv`, [['Event', 'Date', 'Name', 'Checked in', 'How'],
          ...rows.map((r) => { const x = byId.get(r.event_id); return [x.title, x.starts_at.slice(0, 10), profile(r.profile_id)?.name || 'Former member', new Date(r.checked_in_at).toLocaleString('en-US'), HOW[r.method] || r.method]; })]);
      } catch (err) { s.error(why(err)); }
    }
  });
  load().then(draw, (err) => s.set(`<p class="empty">${esc(why(err))}</p>`));
}

// The Past events button at the bottom of This week, for officers.
export function renderWeekExtra() {
  const el = $('#week-extra');
  if (!el) return;
  const want = isOfficer();
  if (want === Boolean($('[data-ci="past"]', el))) return;
  el.innerHTML = want ? '<button class="btn" type="button" data-ci="past"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Past events and attendance</button>' : '';
}
document.addEventListener('click', (e) => { if (e.target.closest('#week-extra [data-ci="past"]')) openPast(); });
document.addEventListener('dash:data', renderWeekExtra);
document.addEventListener('dash:scene', renderWeekExtra);
onChange(renderWeekExtra);

// ---------- Brothers: Event check-in (Quick access) ----------

export function openCheckin(prefill = '', opts = {}) {
  if (!isMember()) return asMember(() => openCheckin(prefill, opts));
  const s = openSheet({ title: 'Event check-in' });
  let mine = [];
  const draw = (code = prefill) => {
    if (s.closed) return;
    const open = openNow();
    const here = open.filter((x) => x.need_location);  // check in by being there
    const codeOnly = open.filter((x) => !x.need_location); // online events: the code
    const term = semesters(1)[0];
    const thisTerm = mine.filter((r) => r.event_history && r.event_history.starts_at >= term.start.toISOString());
    s.set(`<div class="form-error" role="alert"></div>
      ${here.length ? `<div class="fsec plain ci-here">
          <h3>Check-in open now</h3>
          <p class="ci-here-title">${here.map((x) => `<b>${esc(x.title)}</b> <span class="muted">${esc(time(x.starts_at))}</span>`).join('<br>')}</p>
          <button class="btn primary block ci-go" type="button" data-ci="here">Check in here</button>
          <p class="hint">If you're at the event, that's all. Your phone's location is checked once and isn't saved.</p>
        </div>
        <p class="ci-or"><span>or type the code</span></p>`
      : codeOnly.length ? `<div class="fsec plain ci-open"><h3>Check-in open now</h3><ul class="rows">${codeOnly.map((x) => `<li class="rowi"><span class="rowi-main"><span class="rowi-title">${esc(x.title)}</span><span class="rowi-sub">${esc(time(x.starts_at))} · type the code from the officer</span></span></li>`).join('')}</ul></div>`
      : '<div class="fsec plain ci-open"><p class="muted small-text" style="margin:0">No event has check-in open right now. An officer starts it at the event.</p></div>'}
      <label class="field"><span class="lab">Event code</span>
        <input class="input ci-input" name="code" value="${esc(code)}" maxlength="6" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" aria-label="Event code, 4 characters"></label>
      <button class="btn ${here.length ? '' : 'primary '}block ci-go" type="button" data-ci="go">Check in with the code</button>
      <div class="fsec plain ci-mine"><h3>Your attendance · ${esc(term.label)}</h3>
        ${thisTerm.length ? `<ul class="rows">${thisTerm.map((r) => `<li class="rowi"><span class="rowi-main"><span class="rowi-title">${esc(r.event_history.title)}</span><span class="rowi-sub">${esc(when(r.event_history))}</span></span><span class="ci-done">✓</span></li>`).join('')}</ul>` : '<p class="muted small-text">No events yet this semester.</p>'}
      </div>`);
  };
  const success = (res) => {
    s.set(`<div class="ci-success" role="status">
      <div class="ci-tick" aria-hidden="true">✓</div>
      <h3>${res.already ? 'You were already checked in' : "You're checked in"}</h3>
      <p><b>${esc(res.title)}</b><br><span class="muted">${esc(when(res))}</span></p>
      <button class="btn block" type="button" data-sheet="close">Done</button></div>`);
    if (!res.already) toast(`Checked in to ${res.title}.`);
    document.dispatchEvent(new CustomEvent('dash:checkin'));
  };
  const busy = (btn, text) => { const was = btn?.textContent; if (btn) { btn.disabled = true; btn.textContent = text; } return () => { if (btn && !s.closed) { btn.disabled = false; btn.textContent = was; } }; };

  // One tap: no code, just the phone's location.
  const goHere = async (eventId = null) => {
    s.error('');
    const done = busy($('[data-ci="here"]', s.body), 'Finding you…');
    try {
      const at = await locate();
      success(await rpc('check_in_here', { p_lat: at.lat, p_lng: at.lng, p_accuracy: at.accuracy, p_event: eventId }));
    } catch (err) { s.error(why(err)); done(); }
  };
  // The code (with the location too, when the event checks it).
  const goCode = async () => {
    const code = ($('[name="code"]', s.body)?.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) return s.error('Type the 4-character code from the officer.');
    s.error('');
    const done = busy($('[data-ci="go"]', s.body), 'Checking…');
    let at = {}, geoErr = null;
    const open = await loadOpenNow(true);
    if (!open.length || open.some((x) => x.need_location)) {
      try { at = await locate(); } catch (err) { geoErr = err; }
    }
    try {
      const res = await rpc('check_in', { p_code: code, p_lat: at.lat ?? null, p_lng: at.lng ?? null, p_accuracy: at.accuracy ?? null });
      if (res?.error) throw new Error(res.error); // a wrong code comes back as an answer, not an error
      success(res);
    } catch (err) {
      s.error(geoErr && /need_location/.test(String(err?.message || '')) ? why(geoErr) : why(err));
      done();
    }
  };
  s.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-ci="here"]')) goHere();
    if (e.target.closest('[data-ci="go"]')) goCode();
  });
  s.body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[name="code"]')) { e.preventDefault(); goCode(); } });
  s.body.addEventListener('input', (e) => { if (e.target.matches('[name="code"]')) e.target.value = e.target.value.toUpperCase(); });
  s.set('<p class="empty">Loading…</p>');
  Promise.all([
    loadOpenNow(true),
    sb.from('attendance').select('checked_in_at, event_history(title, starts_at, all_day)').eq('profile_id', S.user.id).order('checked_in_at', { ascending: false }).limit(100),
  ]).then(([, a]) => {
    mine = a.data || [];
    draw();
    if (opts.here) goHere(opts.here);                                  // "Check in here" from the event's details
    else if (prefill || !openNow().some((x) => x.need_location)) setTimeout(() => $('[name="code"]', s.body)?.focus(), 50);
  }, () => draw());
}
