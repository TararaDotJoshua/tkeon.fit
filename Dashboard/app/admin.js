// Admin screens: members and their positions, positions and committees,
// board columns, custom fields, and restoring archived goals and issues.
// The database enforces who may do these; this file is only the screens.

import { $, confirmSheet, esc, field, fmtDate, formData, openSheet, opt, toast } from './ui.js';
import { S, sb, avatar, isAdmin, load, teamChips, teamsOfProfile, write } from './store.js';

const FIELD_TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['link', 'Link'], ['select', 'Choice list'], ['checkbox', 'Checkbox']];
const typeLabel = (t) => FIELD_TYPES.find(([v]) => v === t)?.[1] || t;
const row = (attrs, title, sub, lead = '') => `<li><button class="rowi" type="button" ${attrs}>${lead}<span class="rowi-main"><span class="rowi-title">${title}</span>${sub ? `<span class="rowi-sub">${sub}</span>` : ''}</span><span class="chev" aria-hidden="true">›</span></button></li>`;

/** The admin entries, as list rows. Settings shows them; a click anywhere inside goes through manageClick(). */
export const manageRows = () => `<ul class="rows">
  ${row('data-go="members"', 'Members', 'Positions, admins, resetting accounts')}
  ${row('data-go="teams"', 'Positions and committees', 'What issues and goals can be assigned to')}
  ${row('data-go="columns"', 'Board columns', 'Add, rename, reorder')}
  ${row('data-go="fields"', 'Custom fields', 'Extra fields on every issue')}
  ${row('data-go="archive"', 'Archived items', 'Restore goals and issues')}
</ul>`;
export function manageClick(e) {
  const go = e.target.closest('[data-go]')?.dataset.go;
  if (!go) return false;
  if (!isAdmin()) { toast('Admins only.'); return true; }
  ({ members: openMembers, teams: openTeams, columns: openColumns, fields: openFields, archive: openArchive })[go]?.();
  return true;
}

/** A list sheet that redraws itself after every change. */
function listSheet(title, draw, onClick) {
  const s = openSheet({ title });
  const redraw = () => { if (!s.closed) s.set(draw()); };
  redraw();
  s.body.addEventListener('click', (e) => onClick(e, redraw, s));
  return { s, redraw };
}

// ---------- Members ----------

function openMembers() {
  listSheet('Members', () => `<ul class="rows fsec plain">${S.profiles.map((p) => row(`data-member="${p.id}"`, esc(p.name || 'No name yet') + (p.is_admin ? ' · Admin' : p.can_recruit ? ' · Recruitment' : '') + (p.disabled ? ' · Turned off' : ''), `${p.grad_year ? `Class of ${esc(p.grad_year)}` : 'No year yet'}${teamsOfProfile(p.id).length ? ' · ' + teamsOfProfile(p.id).map((t) => esc(t.name)).join(', ') : ''}`, avatar(p))).join('') || '<li class="muted">Nobody has signed in yet.</li>'}</ul>
    <p class="muted small-text">Members appear here after their first sign-in.</p>`,
  (e, redraw) => { const id = e.target.closest('[data-member]')?.dataset.member; if (id) openMember(id, redraw); });
}

function openMember(id, after) {
  const p = S.profiles.find((x) => x.id === id);
  if (!p) return;
  const me = p.id === S.user.id;
  const mine = new Set(S.profileTeams.filter((x) => x.profile_id === id).map((x) => x.team_id));
  const teams = S.teams.filter((t) => !t.archived_at);
  const s = openSheet({
    title: p.name || 'Member', primary: 'Save',
    html: `<div class="form-error" role="alert"></div>
      <div class="fsec plain"><div class="profile-top">${avatar(p, 'lg')}<div><h3>${esc(p.name || 'No name yet')}</h3><div class="muted">${p.grad_year ? `Class of ${esc(p.grad_year)}` : 'No graduation year yet'}</div></div></div></div>
      <div class="fsec"><h3>Positions and committees</h3>
        <div class="checks" style="margin-bottom:.85rem">${teams.map((t) => `<label class="check"><input type="checkbox" name="teams" data-multi value="${t.id}"${mine.has(t.id) ? ' checked' : ''}><span>${esc(t.name)}</span></label>`).join('') || '<span class="muted small-text">None exist yet.</span>'}</div>
      </div>
      <div class="fsec"><h3>Access</h3>
        <label class="switch"><span>Recruitment access</span><input type="checkbox" name="can_recruit"${p.can_recruit || p.is_admin ? ' checked' : ''}${p.is_admin ? ' disabled' : ''}></label>
        ${p.is_admin ? '<p class="muted small-text">Admins always have recruitment access.</p>' : '<p class="muted small-text">Lets him see and edit PNMs in the Recruitment tab.</p>'}
        <label class="switch"><span>Admin</span><input type="checkbox" name="is_admin"${p.is_admin ? ' checked' : ''}${me ? ' disabled' : ''}></label>
        <label class="switch"><span>Account turned off</span><input type="checkbox" name="disabled"${p.disabled ? ' checked' : ''}${me ? ' disabled' : ''}></label>
        ${me ? '<p class="muted small-text">You can\'t change your own access.</p>' : ''}
      </div>
      ${me ? '' : '<div class="btn-row"><button class="btn danger" type="button" data-do="reset">Reset account</button></div><p class="muted small-text">Resetting removes the account and frees the scroll number, so the brother can sign up again. His goals and issues stay.</p>'}`,
    onPrimary: async () => {
      const f = formData(s.body);
      const want = new Set(f.teams || []);
      const add = [...want].filter((t) => !mine.has(t)), drop = [...mine].filter((t) => !want.has(t));
      if (add.length) await write(sb.from('profile_teams').insert(add.map((team_id) => ({ profile_id: id, team_id }))));
      if (drop.length) await write(sb.from('profile_teams').delete().eq('profile_id', id).in('team_id', drop));
      if (!me && (f.is_admin !== p.is_admin || f.disabled !== p.disabled)) await write(sb.rpc('admin_set_member', { p_id: id, p_is_admin: f.is_admin, p_disabled: f.disabled }));
      if (!p.is_admin && f.can_recruit !== Boolean(p.can_recruit)) await write(sb.rpc('admin_set_recruiter', { p_id: id, p_on: f.can_recruit }));
      await load();
      s.close();
      toast('Saved.');
      after?.();
    },
  });
  s.body.addEventListener('click', async (e) => {
    if (e.target.closest('[data-do="reset"]')) {
      if (!(await confirmSheet('Reset this account?', `${p.name || 'This member'} will have to sign up again with his FIT email and scroll number.`, 'Reset'))) return;
      await write(sb.rpc('admin_reset_member', { p_id: id }));
      await load();
      s.close();
      toast('Account reset.');
      after?.();
    }
  });
}

// ---------- Generic "name + a few options" editors ----------

/** Swap an item's sort value with its neighbour to move it up or down. */
async function nudge(table, list, id, dir) {
  const i = list.findIndex((x) => x.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const a = list[i], b = list[j];
  // Swap the two sort values; if they happen to be equal, step past the neighbour.
  const aSort = a.sort === b.sort ? b.sort + dir : b.sort;
  await write(sb.from(table).update({ sort: aSort }).eq('id', a.id));
  await write(sb.from(table).update({ sort: a.sort }).eq('id', b.id));
  await load();
}
const mover = (id, n, len) => `<span><button class="btn quiet small" type="button" data-up="${id}" aria-label="Move up"${n === 0 ? ' disabled' : ''}>↑</button><button class="btn quiet small" type="button" data-down="${id}" aria-label="Move down"${n === len - 1 ? ' disabled' : ''}>↓</button></span>`;
const editRow = (id, title, sub, n, len) => `<li class="rowi"><span class="rowi-main"><span class="rowi-title">${title}</span>${sub ? `<span class="rowi-sub">${sub}</span>` : ''}</span>${mover(id, n, len)}<button class="btn small" type="button" data-edit="${id}">Edit</button></li>`;

function openTeams() {
  const live = () => S.teams.filter((t) => !t.archived_at);
  listSheet('Positions and committees', () => {
    const block = (kind, label) => { const l = live().filter((t) => t.kind === kind); return `<div class="fsec plain"><h3>${label}</h3><ul class="rows">${l.map((t, n) => editRow(t.id, esc(t.name), '', n, l.length)).join('') || '<li class="muted small-text">None yet.</li>'}</ul><div class="btn-row"><button class="btn small" type="button" data-new="${kind}">+ Add a ${kind}</button></div></div>`; };
    return block('position', 'Positions') + block('committee', 'Committees');
  }, async (e, redraw) => {
    const up = e.target.closest('[data-up]')?.dataset.up, down = e.target.closest('[data-down]')?.dataset.down;
    if (up || down) { const t = S.teams.find((x) => x.id === (up || down)); await nudge('teams', live().filter((x) => x.kind === t.kind), t.id, up ? -1 : 1); return redraw(); }
    const kind = e.target.closest('[data-new]')?.dataset.new, edit = e.target.closest('[data-edit]')?.dataset.edit;
    if (!kind && !edit) return;
    const t = edit ? S.teams.find((x) => x.id === edit) : { kind, name: '' };
    simpleForm(edit ? `Edit ${t.kind}` : `New ${kind}`, field('Name', `<input class="input" name="name" maxlength="80" value="${esc(t.name)}" required>`), async (f) => {
      if (!f.name) throw new Error('Enter a name.');
      if (edit) await write(sb.from('teams').update({ name: f.name }).eq('id', edit));
      else await write(sb.from('teams').insert({ kind, name: f.name, sort: Math.max(0, ...live().map((x) => x.sort)) + 10 }));
    }, redraw, edit ? async () => { await write(sb.from('teams').update({ archived_at: new Date().toISOString() }).eq('id', edit)); } : null, 'It stays on old issues and goals but can no longer be picked.');
  });
}

function openColumns() {
  listSheet('Board columns', () => `<div class="fsec plain"><ul class="rows">${S.columns.map((c, n) => editRow(c.id, esc(c.name), c.is_done ? 'Counts as done' : '', n, S.columns.length)).join('')}</ul><div class="btn-row"><button class="btn small" type="button" data-new="1">+ Add a column</button></div></div>`,
  async (e, redraw) => {
    const up = e.target.closest('[data-up]')?.dataset.up, down = e.target.closest('[data-down]')?.dataset.down;
    if (up || down) { await nudge('board_columns', S.columns, up || down, up ? -1 : 1); return redraw(); }
    const isNew = e.target.closest('[data-new]'), edit = e.target.closest('[data-edit]')?.dataset.edit;
    if (!isNew && !edit) return;
    const c = edit ? S.columns.find((x) => x.id === edit) : { name: '', is_done: false };
    const used = edit ? S.issues.filter((i) => i.column_id === edit).length : 0;
    simpleForm(edit ? 'Edit column' : 'New column', field('Name', `<input class="input" name="name" maxlength="40" value="${esc(c.name)}" required>`) + `<label class="switch"><span>Issues here count as done</span><input type="checkbox" name="is_done"${c.is_done ? ' checked' : ''}></label>`, async (f) => {
      if (!f.name) throw new Error('Enter a name.');
      if (edit) await write(sb.from('board_columns').update({ name: f.name, is_done: f.is_done }).eq('id', edit));
      else await write(sb.from('board_columns').insert({ name: f.name, is_done: f.is_done, sort: Math.max(0, ...S.columns.map((x) => x.sort)) + 10 }));
    }, redraw, edit && S.columns.length > 1 ? async () => {
      if (used) throw new Error(`Move or archive the ${used} issue${used === 1 ? '' : 's'} in this column first.`);
      await write(sb.from('board_columns').update({ archived_at: new Date().toISOString() }).eq('id', edit));
    } : null, 'The column leaves the board.');
  });
}

function openFields() {
  listSheet('Custom fields', () => `<div class="fsec plain"><ul class="rows">${S.fields.map((f, n) => editRow(f.id, esc(f.name), `${typeLabel(f.type)}${f.show_on_card ? ' · shown on the card' : ''}`, n, S.fields.length)).join('') || '<li class="muted small-text">None yet. Deadline and document links are built in.</li>'}</ul><div class="btn-row"><button class="btn small" type="button" data-new="1">+ Add a field</button></div></div>`,
  async (e, redraw) => {
    const up = e.target.closest('[data-up]')?.dataset.up, down = e.target.closest('[data-down]')?.dataset.down;
    if (up || down) { await nudge('custom_fields', S.fields, up || down, up ? -1 : 1); return redraw(); }
    const isNew = e.target.closest('[data-new]'), edit = e.target.closest('[data-edit]')?.dataset.edit;
    if (!isNew && !edit) return;
    const f0 = edit ? S.fields.find((x) => x.id === edit) : { name: '', type: 'text', options: [], show_on_card: false };
    simpleForm(edit ? 'Edit field' : 'New field',
      field('Name', `<input class="input" name="name" maxlength="40" value="${esc(f0.name)}" placeholder="Budget" required>`) +
      field('Type', `<select class="input" name="type"${edit ? ' disabled' : ''}>${FIELD_TYPES.map(([v, l]) => opt(v, l, f0.type)).join('')}</select>`, edit ? "A field's type can't change once it's in use." : '') +
      field('Choices', `<input class="input" name="options" value="${esc((f0.options || []).join(', '))}" placeholder="Low, Medium, High">`, 'For a choice list: the choices, separated by commas.') +
      `<label class="switch"><span>Show on the card</span><input type="checkbox" name="show_on_card"${f0.show_on_card ? ' checked' : ''}></label>`,
      async (f) => {
        const type = edit ? f0.type : f.type;
        const options = type === 'select' ? [...new Set(f.options.split(',').map((x) => x.trim()).filter(Boolean))] : [];
        if (!f.name) throw new Error('Enter a name.');
        if (type === 'select' && options.length < 2) throw new Error('A choice list needs at least two choices.');
        const rowData = { name: f.name, options, show_on_card: f.show_on_card };
        if (edit) await write(sb.from('custom_fields').update(rowData).eq('id', edit));
        else await write(sb.from('custom_fields').insert({ ...rowData, type, sort: Math.max(0, ...S.fields.map((x) => x.sort)) + 10 }));
      }, redraw, edit ? async () => { await write(sb.from('custom_fields').update({ archived_at: new Date().toISOString() }).eq('id', edit)); } : null, 'The field disappears from issues. Values already entered are kept.');
  });
}

/** A small form sheet with Save, and an optional "Remove" that archives. */
function simpleForm(title, html, save, after, remove, removeNote) {
  const s = openSheet({
    title, primary: 'Save',
    html: `<div class="form-error" role="alert"></div><div class="fsec">${html}</div>${remove ? '<div class="btn-row"><button class="btn danger" type="button" data-do="remove">Remove</button></div>' : ''}`,
    onPrimary: async () => { await save(formData(s.body)); await load(); s.close(); after?.(); },
  });
  s.body.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-do="remove"]')) return;
    if (!(await confirmSheet('Remove this?', removeNote, 'Remove'))) return;
    try { await remove(); await load(); s.close(); after?.(); } catch (err) { s.error(err.message); }
  });
  setTimeout(() => $('[name="name"]', s.body)?.focus(), 50);
}

// ---------- Archived items ----------

async function openArchive() {
  const s = openSheet({ title: 'Archived items', html: '<p class="empty">Loading…</p>' });
  const draw = async () => {
    const [g, i] = await Promise.all([
      sb.from('goals').select('id,title,archived_at').not('archived_at', 'is', null).order('archived_at', { ascending: false }),
      sb.from('issues').select('id,title,archived_at').not('archived_at', 'is', null).order('archived_at', { ascending: false }),
    ]);
    if (s.closed) return;
    const list = (rows, kind) => (rows?.length ? `<ul class="rows">${rows.map((r) => `<li class="rowi"><span class="rowi-main"><span class="rowi-title">${esc(r.title)}</span><span class="rowi-sub">Archived ${esc(fmtDate(r.archived_at))}</span></span><button class="btn small" type="button" data-restore="${kind}:${r.id}">Restore</button></li>`).join('')}</ul>` : '<p class="muted small-text">Nothing archived.</p>');
    s.set(`<div class="fsec plain"><h3>Goals</h3>${list(g.data, 'goals')}</div><div class="fsec plain"><h3>Issues</h3>${list(i.data, 'issues')}</div>`);
  };
  s.body.addEventListener('click', async (e) => {
    const r = e.target.closest('[data-restore]')?.dataset.restore;
    if (!r) return;
    const [table, id] = r.split(':');
    const patch = { archived_at: null };
    // An issue whose column was removed comes back in the first column.
    if (table === 'issues') { const { data } = await sb.from('issues').select('column_id').eq('id', id).single(); if (!S.columns.some((c) => c.id === data?.column_id)) patch.column_id = S.columns[0].id; }
    await write(sb.from(table).update(patch).eq('id', id));
    await load();
    toast('Restored.');
    draw();
  });
  draw();
}
