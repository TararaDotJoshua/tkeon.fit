// The Goals tab: measurable goals with a number to hit and a date.
// A goal either follows a KRA (updated by the hourly sync) or is updated by check-ins.

import { $, confirmSheet, daysUntil, esc, field, fmtDate, fmtStamp, fmtVal, formData, numOrNull, openSheet, opt, toast, today, ymd } from './ui.js';
import { S, sb, activeTeams, column, goalView, isMember, issuesOfGoal, kras, load, profile, statusTag, team, unitOfKra, write } from './store.js';
import { asMember } from './auth.js';
import { openIssue } from './board.js';

const D = window.DASH;
let filter = 'active';
const UNITS = [['number', 'A number'], ['currency', 'Dollars'], ['percent', 'A percentage'], ['boolean', 'Done or not done']];

const meter = (v) => D.meter(v.pct * 100, v.pace, `${Math.round(v.pct * 100)}% of the way${v.pace != null ? `; on pace would be ${Math.round(v.pace * 100)}%` : ''}`);
const valueLine = (g, v) => (g.unit === 'boolean'
  ? `<b>${esc(fmtVal('boolean', v.cur))}</b>`
  : `<b>${esc(v.cur == null ? 'Not reported' : fmtVal(g.unit, v.cur))}</b> <span>of ${esc(fmtVal(g.unit, g.target_value))}</span>`);
function dueLine(g, v) {
  if (!v.open) return `Due ${fmtDate(g.due_date)}`;
  const d = daysUntil(g.due_date);
  return `Due ${fmtDate(g.due_date)} · ${d < 0 ? `${-d} day${d === -1 ? '' : 's'} late` : d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} left`}`;
}

// ---------- List ----------

export function renderGoals() {
  const el = $('#scene-goals');
  if (!el || el.hidden) return;
  if (S.error && !S.loaded) { el.innerHTML = `<p class="app-note">Couldn't load goals. Check your connection; it will retry.</p>`; return; }
  if (!S.loaded) { el.innerHTML = '<p class="empty">Loading…</p>'; return; }
  const shown = S.goals.filter((g) => filter === 'all' || g.status === filter);
  const cards = shown.map((g) => {
    const v = goalView(g);
    const owner = team(g.owner_team_id);
    const issues = issuesOfGoal(g.id);
    const openCount = issues.filter((i) => !column(i.column_id)?.is_done).length;
    return `<article class="panel gcard s-${v.status.key}${v.open ? '' : ' is-closed'}" data-goal="${g.id}" tabindex="0" role="button" aria-label="${esc(g.title)}, ${esc(v.status.label)}">
      <div class="gcard-top"><h3>${esc(g.title)}</h3>${statusTag(v.status)}</div>
      <div class="gcard-owner">${owner ? `<span class="chip">${esc(owner.name)}</span>` : ''}${v.kra ? ` <span class="chip">Follows ${esc(v.kra.name)}</span>` : ''}</div>
      <div class="g-val">${valueLine(g, v)}</div>
      ${meter(v)}
      <div class="gcard-foot">${esc(dueLine(g, v))}${issues.length ? ` · ${openCount} open issue${openCount === 1 ? '' : 's'}` : ''}</div>
    </article>`;
  }).join('');
  el.innerHTML = `<div class="app-head"><h2>Goals</h2>
      <select class="mini" id="goal-filter" aria-label="Which goals to show">${opt('active', 'Active', filter)}${opt('achieved', 'Achieved', filter)}${opt('dropped', 'Dropped', filter)}${opt('all', 'All', filter)}</select>
      <button class="btn primary small" type="button" data-goal-new><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>New</button>
    </div>
    ${shown.length ? `<div class="goal-list">${cards}</div>` : `<div class="app-note">${S.goals.length ? 'No goals in this view.' : 'No goals yet. A goal needs a number to hit and a date, like "Raise $8,000 for St. Jude by May 31".'}${isMember() ? '' : '<br><button class="btn small" type="button" data-act="signin">Sign in to add one</button>'}</div>`}`;
}

document.addEventListener('change', (e) => { if (e.target.id === 'goal-filter') { filter = e.target.value; renderGoals(); } });
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-goal-new]')) return asMember(() => openGoalForm());
  const card = e.target.closest('#scene-goals [data-goal]');
  if (card) openGoal(card.dataset.goal);
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('#scene-goals [data-goal]')) { e.preventDefault(); openGoal(e.target.dataset.goal); }
});

// ---------- Detail ----------

function sparkline(points) {
  if (points.length < 2) return '';
  const xs = points.map((p) => p.t), ys = points.map((p) => p.v);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y1 = Math.max(...ys, 1e-9), y0 = Math.min(...ys, 0);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(((p.t - x0) / Math.max(1, x1 - x0)) * 100).toFixed(2)},${(100 - ((p.v - y0) / Math.max(1e-9, y1 - y0)) * 96 - 2).toFixed(2)}`).join('');
  return `<svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="History: ${points.length} points"><path class="area" d="${d}L100,100L0,100Z"/><path d="${d}" vector-effect="non-scaling-stroke"/></svg>`;
}

export async function openGoal(id) {
  const g = S.goals.find((x) => x.id === id);
  if (!g) return toast("That goal isn't here any more.");
  history.replaceState(null, '', `#goals/${id}`);
  const s = openSheet({ title: 'Goal', onClose: () => { if (location.hash === `#goals/${id}`) history.replaceState(null, '', '#goals'); } });

  // The history chart and change log load after the sheet is up. They fill their
  // own slots, so they never wipe a check-in someone has started typing.
  const extra = { spark: '', activity: '' };
  const fill = () => { const a = $('[data-slot="spark"]', s.body), b = $('[data-slot="activity"]', s.body); if (a) a.innerHTML = extra.spark; if (b) b.innerHTML = extra.activity; };
  const draw = () => {
    const goal = S.goals.find((x) => x.id === id) || g;
    const v = goalView(goal);
    const owner = team(goal.owner_team_id);
    const issues = issuesOfGoal(id);
    const canEdit = isMember();
    s.set(`<div class="fsec plain g-hero s-${v.status.key}">
        <div class="gcard-top"><h3 style="font-size:1.3rem">${esc(goal.title)}</h3>${statusTag(v.status)}</div>
        <div class="g-val">${valueLine(goal, v)}</div>
        ${meter(v)}
        <div class="gcard-foot">${esc(dueLine(goal, v))}${v.pace != null ? ` · ${Math.round(v.pace * 100)}% of the time gone` : ''}</div>
        <div data-slot="spark">${extra.spark}</div>
      </div>
      ${canEdit && v.open && !v.kra && goal.unit !== 'boolean' ? `<div class="fsec"><h3>Add a check-in</h3>
        <div class="row2">${field('New value', `<input class="input" name="value" type="number" inputmode="decimal" step="any" placeholder="${esc(v.cur ?? '')}">`)}${field('Note (optional)', '<input class="input" name="note" maxlength="500">')}</div>
        <button class="btn primary small" type="button" data-do="checkin" style="margin-bottom:.85rem">Save check-in</button></div>` : ''}
      ${canEdit && v.open && !v.kra && goal.unit === 'boolean' ? `<div class="btn-row" style="margin:0 0 .9rem"><button class="btn primary" type="button" data-do="done">Mark as done</button></div>` : ''}
      <div class="fsec plain"><dl class="kv">
        ${goal.description ? `<dt>What exactly</dt><dd class="prose">${esc(goal.description)}</dd>` : ''}
        <dt>Measured by</dt><dd>${v.kra ? `The ${esc(v.kra.name)} KRA, updated by the hourly sync` : 'Check-ins'}</dd>
        <dt>Start</dt><dd>${esc(fmtVal(goal.unit, goal.start_value))} on ${esc(fmtDate(goal.start_date))}</dd>
        <dt>Target</dt><dd>${esc(fmtVal(goal.unit, goal.target_value))} by ${esc(fmtDate(goal.due_date))}</dd>
        <dt>Owner</dt><dd>${owner ? esc(owner.name) : '<span class="muted">Nobody yet</span>'}</dd>
        ${goal.why ? `<dt>Why it matters</dt><dd class="prose">${esc(goal.why)}</dd>` : ''}
      </dl></div>
      <div class="fsec plain"><h3>Issues for this goal</h3>
        ${issues.length ? `<ul class="rows">${issues.map((i) => `<li><button class="rowi" type="button" data-issue="${i.id}"><span class="rowi-main"><span class="rowi-title">${esc(i.title)}</span><span class="rowi-sub">${esc(column(i.column_id)?.name || '')}${i.due_date ? ` · due ${esc(fmtDate(i.due_date))}` : ''}</span></span><span class="chev" aria-hidden="true">›</span></button></li>`).join('')}</ul>` : '<p class="muted small-text">None yet.</p>'}
        ${canEdit ? '<div class="btn-row"><button class="btn small" type="button" data-do="add-issue">Add an issue</button></div>' : ''}
      </div>
      <div data-slot="activity">${extra.activity}</div>
      ${canEdit ? `<div class="btn-row">
        <button class="btn" type="button" data-do="edit">Edit</button>
        ${goal.status === 'active' ? '<button class="btn" type="button" data-do="achieved">Mark achieved</button><button class="btn" type="button" data-do="dropped">Drop</button>' : '<button class="btn" type="button" data-do="active">Reopen</button>'}
        <button class="btn danger" type="button" data-do="archive">Archive</button>
      </div>` : '<p class="muted small-text">Sign in to edit goals.</p>'}`);
  };
  draw();

  const refresh = async () => {
    const goal = S.goals.find((x) => x.id === id);
    if (!goal || s.closed) return;
    const [hist, act] = await Promise.all([
      goal.kra_id
        ? sb.from('kra_snapshots').select('day,current').eq('kra_id', goal.kra_id).order('day')
        : sb.from('goal_checkins').select('value,created_at').eq('goal_id', id).order('created_at'),
      sb.from('activity').select('at,actor,action,summary').eq('entity', 'goal').eq('entity_id', id).order('id', { ascending: false }).limit(8),
    ]);
    const points = goal.kra_id
      ? (hist.data || []).filter((r) => r.current != null).map((r) => ({ t: Date.parse(r.day), v: Number(r.current) }))
      : [{ t: Date.parse(goal.start_date), v: Number(goal.start_value) }, ...(hist.data || []).map((r) => ({ t: Date.parse(r.created_at), v: Number(r.value) }))];
    extra.spark = sparkline(points);
    extra.activity = act.data?.length ? `<div class="fsec plain"><h3>Recent changes</h3><ul class="act">${act.data.map((a) => `<li><b>${esc(profile(a.actor)?.name || 'Someone')}</b> ${esc(a.action)}${a.action === 'check-in' ? ` ${esc(a.summary || '')}` : ''} · ${esc(fmtStamp(a.at))}</li>`).join('')}</ul></div>` : '';
    if (!s.closed) fill();
  };
  refresh();

  s.body.addEventListener('click', async (e) => {
    const issueBtn = e.target.closest('[data-issue]');
    if (issueBtn) return openIssue(issueBtn.dataset.issue);
    const act = e.target.closest('[data-do]')?.dataset.do;
    if (!act) return;
    const goal = S.goals.find((x) => x.id === id);
    if (act === 'edit') return openGoalForm(goal, () => { draw(); refresh(); });
    if (act === 'add-issue') return openIssue(null, { goal_id: id }, () => draw());
    if (act === 'checkin' || act === 'done') {
      const v = formData(s.body);
      const value = act === 'done' ? 1 : numOrNull(v.value);
      if (value == null) return toast('Enter the new value.');
      await write(sb.from('goal_checkins').insert({ goal_id: id, value, note: v.note || null }));
      await load();
      toast('Check-in saved.');
      draw(); refresh();
      return;
    }
    if (act === 'archive') {
      if (!(await confirmSheet('Archive this goal?', 'It leaves the Goals tab. Its issues stay on the board. An admin can restore it.', 'Archive'))) return;
      await write(sb.from('goals').update({ archived_at: new Date().toISOString() }).eq('id', id));
      await load();
      s.close();
      return toast('Goal archived.');
    }
    await write(sb.from('goals').update({ status: act }).eq('id', id));
    await load();
    draw(); refresh();
  });
}

// ---------- New / edit ----------

export function openGoalForm(g = null, after) {
  const k = kras();
  const v = g || { unit: 'number', start_value: 0, start_date: ymd(today()), status: 'active' };
  const s = openSheet({
    title: g ? 'Edit goal' : 'New goal', primary: 'Save',
    html: `<div class="form-error" role="alert"></div>
      <div class="fsec"><h3><em>S</em>What exactly</h3>
        ${field('Goal', `<input class="input" name="title" maxlength="160" value="${esc(v.title || '')}" placeholder="Raise $8,000 for St. Jude" required>`)}
        ${field('Details (optional)', `<textarea class="input" name="description" maxlength="2000">${esc(v.description || '')}</textarea>`)}
      </div>
      <div class="fsec"><h3><em>M</em>How it's measured</h3>
        ${field('Track it', `<select class="input" name="kra_id">${opt('', 'With check-ins we enter ourselves', v.kra_id || '')}${k.map((x) => opt(x.id, `Automatically, from the ${x.name} KRA`, v.kra_id || '')).join('')}</select>`, 'A goal that follows a KRA updates itself every hour.')}
        ${field('Measured in', `<select class="input" name="unit">${UNITS.map(([val, label]) => opt(val, label, v.unit)).join('')}</select>`)}
        <div class="row2" data-numbers>
          ${field('Starting at', `<input class="input" name="start_value" type="number" inputmode="decimal" step="any" value="${esc(v.start_value ?? 0)}">`)}
          ${field('Target', `<input class="input" name="target_value" type="number" inputmode="decimal" step="any" value="${esc(v.target_value ?? '')}" required>`)}
        </div>
      </div>
      <div class="fsec"><h3><em>A</em>Who owns it</h3>
        ${field('Position or committee', `<select class="input" name="owner_team_id">${opt('', 'Nobody yet', v.owner_team_id || '')}${activeTeams().map((t) => opt(t.id, t.name, v.owner_team_id || '')).join('')}</select>`)}
      </div>
      <div class="fsec"><h3><em>R</em>Why it matters</h3>
        ${field('Reason (optional)', `<textarea class="input" name="why" maxlength="2000">${esc(v.why || '')}</textarea>`)}
      </div>
      <div class="fsec"><h3><em>T</em>By when</h3>
        <div class="row2">
          ${field('Start date', `<input class="input" name="start_date" type="date" value="${esc(v.start_date || '')}" required>`)}
          ${field('Due date', `<input class="input" name="due_date" type="date" value="${esc(v.due_date || '')}" required>`)}
        </div>
      </div>`,
    onPrimary: async () => {
      const f = formData(s.body);
      const bool = f.unit === 'boolean';
      const row = {
        title: f.title, description: f.description || null, why: f.why || null, unit: f.unit,
        kra_id: f.kra_id || null, owner_team_id: f.owner_team_id || null,
        start_value: bool ? 0 : numOrNull(f.start_value) ?? 0, target_value: bool ? 1 : numOrNull(f.target_value),
        start_date: f.start_date, due_date: f.due_date,
      };
      if (!row.title) return s.error('Give the goal a name.');
      if (row.target_value == null) return s.error('A goal needs a number to hit. Enter the target.');
      if (row.target_value === row.start_value) return s.error('The target has to differ from the starting value.');
      if (!row.start_date || !row.due_date) return s.error('A goal needs a start date and a due date.');
      if (row.due_date < row.start_date) return s.error('The due date must be on or after the start date.');
      if (g) await write(sb.from('goals').update(row).eq('id', g.id));
      else await write(sb.from('goals').insert(row));
      await load();
      s.close();
      toast(g ? 'Goal saved.' : 'Goal added.');
      after?.();
    },
  });
  // Following a KRA fills in the unit, start and target from the sync; yes/no goals need no numbers.
  const sync = (fromKra) => {
    const f = s.body.elements;
    const kra = k.find((x) => x.id === f.kra_id.value);
    if (kra && fromKra) {
      f.unit.value = unitOfKra(kra);
      if (kra.goal != null) f.target_value.value = kra.goal;
      if (!g && kra.current != null) f.start_value.value = kra.current;
    }
    $('[data-numbers]', s.body).hidden = f.unit.value === 'boolean';
  };
  s.body.elements.kra_id.addEventListener('change', () => sync(true));
  s.body.elements.unit.addEventListener('change', () => sync(false));
  sync(false);
}
