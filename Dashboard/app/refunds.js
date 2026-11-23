// Refund requests, from Quick access.
//  - Any signed-in brother files one: a photo of the receipt (taken there and
//    then, or picked from his photos), the amount, what it was for, optionally a
//    committee, and how to pay him back. He sees only his own, and can withdraw
//    one while it's still Submitted.
//  - Whoever holds the Prytanis or Crysophylos position sees everyone's and moves
//    them along: Submitted -> In review -> Processed. The app never moves money.
// The database enforces all of it (supabase/refunds.sql). Receipts live in a
// private bucket and are shown through links that expire after an hour.

import { $, confirmSheet, esc, field, fmtStamp, formData, openSheet, opt, toast } from './ui.js';
import { S, sb, activeTeams, isMember, profile, team, write } from './store.js';

const D = window.DASH;
const RF = { rows: [], loadedFor: null, loading: null, urls: new Map() };

export const STATUSES = [
  { key: 'submitted', label: 'Submitted' },
  { key: 'in_review', label: 'In review' },
  { key: 'processed', label: 'Processed' },
];
const statusOf = (k) => STATUSES.find((s) => s.key === k) || STATUSES[0];
const ST_ICON = {
  submitted: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.7" style="fill:none;stroke:var(--none);stroke-width:2.6"/><path d="M12 7.5V12l3 2" style="fill:none;stroke:var(--none);stroke-width:2.4;stroke-linecap:round"/></svg>',
  in_review: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.7" style="fill:none;stroke:var(--behind);stroke-width:2.6"/><circle cx="11" cy="11" r="3.6" style="fill:none;stroke:var(--behind);stroke-width:2.2"/><path d="M13.7 13.7l2.8 2.8" style="fill:none;stroke:var(--behind);stroke-width:2.4;stroke-linecap:round"/></svg>',
  processed: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" style="fill:var(--met)"/><path d="M6.8 12.4l3.4 3.4 7-7.4" style="fill:none;stroke:var(--panel);stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round"/></svg>',
};
const stTag = (k) => `<span class="st rf-st rf-${k}">${ST_ICON[k] || ''}<span>${esc(statusOf(k).label)}</span></span>`;
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A hint for showing the review screens; the database decides for real. */
export function isRefundReviewer() {
  if (!isMember()) return false;
  const mine = new Set(S.profileTeams.filter((x) => x.profile_id === S.user.id).map((x) => x.team_id));
  return S.teams.some((t) => mine.has(t.id) && t.kind === 'position' && !t.archived_at && /^(prytanis|crysophylos|chrysophylos)\b/i.test(t.name));
}

export const resetRefunds = () => { RF.rows = []; RF.loadedFor = null; RF.urls.clear(); };
const mine = () => RF.rows.filter((r) => r.profile_id === S.user?.id);
const open = () => RF.rows.filter((r) => r.status !== 'processed');

export function loadRefunds() {
  if (!isMember()) return Promise.resolve();
  if (RF.loading) return RF.loading;
  const who = S.user.id;
  RF.loading = sb.from('refund_requests').select('*').order('created_at', { ascending: false }).limit(500)
    .then(({ data, error }) => {
      if (error) throw error;
      if (S.user?.id !== who) return;
      RF.rows = data || [];
      RF.loadedFor = who;
    })
    .catch((e) => console.error(e))
    .finally(() => { RF.loading = null; document.dispatchEvent(new CustomEvent('dash:refunds')); });
  return RF.loading;
}

/** The Quick access tile's second line. */
export function refundTileSub() {
  if (!isMember()) return 'Sign in to ask for a refund';
  if (RF.loadedFor !== S.user.id) return 'Get paid back for chapter purchases';
  if (isRefundReviewer()) {
    const waiting = RF.rows.filter((r) => r.status === 'submitted').length, reviewing = RF.rows.filter((r) => r.status === 'in_review').length;
    if (waiting || reviewing) return `<b class="q-live">${[waiting && `${waiting} new`, reviewing && `${reviewing} in review`].filter(Boolean).join(' · ')}</b>`;
    return 'No open requests';
  }
  const latest = mine()[0];
  return latest && latest.status !== 'processed' ? `Your ${usd(latest.amount)} request · ${esc(statusOf(latest.status).label)}` : 'Get paid back for chapter purchases';
}

// ---------- Receipts ----------

/** Receipts are private: shown through links that expire after an hour. */
async function receiptUrl(path) {
  const have = RF.urls.get(path);
  if (have && have.exp > Date.now() + 5 * 60e3) return have.url;
  const { data, error } = await sb.storage.from('receipts').createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  RF.urls.set(path, { url: data.signedUrl, exp: Date.now() + 3600e3 });
  return data.signedUrl;
}

/** Shrink to at most 1800px on the long side, as a JPEG: small enough to upload
 *  on a phone, big enough to read the totals. Drops the photo's location data. */
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); // a PNG with transparency
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("Couldn't read that photo. Try another."))), 'image/jpeg', 0.85));
}

/** "$12.50", "12.5", "1,200" -> 12.5; anything else -> NaN. */
export function parseAmount(v) {
  const t = String(v ?? '').trim().replace(/^\$\s*/, '').replace(/,/g, '');
  return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : NaN;
}

// ---------- The list ----------

function row(r, showWho) {
  const who = showWho ? (profile(r.profile_id)?.name || 'Former member') : null;
  const c = r.committee_id && team(r.committee_id);
  const sub = [who, fmtStamp(r.created_at), c?.name].filter(Boolean).map(esc).join(' · ');
  return `<button class="rowi rf-row" type="button" data-refund="${r.id}">
      <span class="rowi-main"><span class="rowi-title"><span class="rf-amt">${usd(r.amount)}</span> ${esc(r.what_for)}</span><span class="rowi-sub">${sub}</span></span>
      ${stTag(r.status)}<span class="chev" aria-hidden="true">›</span>
    </button>`;
}

export function openRefunds() {
  if (!isMember()) return;
  const s = openSheet({ title: 'Refunds', onClose: () => document.removeEventListener('dash:refunds', draw) });
  function draw() {
    if (s.closed) return;
    const reviewer = isRefundReviewer();
    const loading = RF.loadedFor !== S.user.id;
    const list = (rows, who, empty) => (rows.length ? `<div class="fsec plain list-box"><ul class="rows">${rows.map((r) => `<li>${row(r, who)}</li>`).join('')}</ul></div>` : `<p class="muted rf-empty">${empty}</p>`);
    let html = `<button class="btn primary block" type="button" data-rf="new">New refund request</button>
      <p class="muted small-text rf-how">Add a photo of the receipt, the amount and how to pay you back. The Prytanis and Crysophylos see it and update its status here.</p>`;
    if (loading) html += '<p class="empty">Loading…</p>';
    else if (reviewer) {
      const others = RF.rows;
      html += `<h3 class="rf-h">To do</h3>${list(others.filter((r) => r.status !== 'processed').sort((a, b) => (a.status === b.status ? 0 : a.status === 'submitted' ? -1 : 1)), true, 'Nothing waiting.')}
        <h3 class="rf-h">Processed</h3>${list(others.filter((r) => r.status === 'processed').slice(0, 40), true, 'None yet.')}`;
    } else {
      html += `<h3 class="rf-h">Your requests</h3>${list(mine(), false, "You haven't asked for a refund yet.")}`;
    }
    s.set(html);
  }
  document.addEventListener('dash:refunds', draw);
  s.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-rf="new"]')) openRefundForm();
    const id = e.target.closest('[data-refund]')?.dataset.refund;
    if (id) openRefund(id);
  });
  draw();
  loadRefunds();
}

// ---------- A new request ----------

export function openRefundForm() {
  if (!isMember()) return;
  let photo = null;
  const committees = activeTeams().filter((t) => t.kind === 'committee').sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
  const lastPay = mine().find((r) => r.pay_to)?.pay_to || '';
  const s = openSheet({
    title: 'Refund request', primary: 'Submit',
    onPrimary: async () => {
      const f = formData(s.body);
      const amount = parseAmount(f.amount);
      if (!photo) return s.error('Add a photo of the receipt.');
      if (!(amount > 0) || amount > 10000) return s.error('Enter the amount on the receipt, like 24.99.');
      if (!f.what_for?.trim()) return s.error('Say what it was for.');
      if (!f.pay_to?.trim()) return s.error('Say how to pay you back, like your Venmo.');
      const path = `${S.user.id}/${crypto.randomUUID()}.jpg`;
      const up = await sb.storage.from('receipts').upload(path, photo, { contentType: 'image/jpeg', upsert: false });
      if (up.error) throw up.error;
      const ins = await sb.from('refund_requests').insert({
        amount, what_for: f.what_for.trim().slice(0, 300), committee_id: f.committee || null, pay_to: f.pay_to.trim().slice(0, 120), receipt_path: path,
      }).select().single();
      if (ins.error) { sb.storage.from('receipts').remove([path]); throw ins.error; }
      RF.rows.unshift(ins.data);
      document.dispatchEvent(new CustomEvent('dash:refunds'));
      s.close();
      toast(`Sent: ${usd(amount)} for ${f.what_for.trim().slice(0, 40)}.`);
    },
  });
  s.set(`<div class="form-error" role="alert"></div>
    <div class="fsec plain">
      <h3>Receipt</h3>
      <div class="rf-pick">
        <span class="rf-prev" id="rf-prev"><span class="rf-ph">No photo yet</span></span>
        <label class="btn" id="rf-pick-btn">Take or add a photo<input type="file" name="receipt" accept="image/*"></label>
      </div>
      <p class="muted small-text">Make sure the store, date and total are readable.</p>
    </div>
    <div class="fsec">
      ${field('Amount', '<input class="input" name="amount" inputmode="decimal" autocomplete="off" placeholder="$0.00" required>', 'What you paid, from the receipt.')}
      ${field('What it was for', '<input class="input" name="what_for" maxlength="300" placeholder="Ice and cups for the philanthropy event" required>')}
      ${field('Committee (optional)', `<select class="input" name="committee">${opt('', 'None')}${committees.map((t) => opt(t.id, t.name)).join('')}</select>`)}
      ${field('How to pay you back', `<input class="input" name="pay_to" maxlength="120" value="${esc(lastPay)}" placeholder="Venmo @name, or Zelle phone or email" required>`, 'Only the Prytanis and Crysophylos see this.')}
    </div>`);
  s.body.querySelector('[name="receipt"]').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    s.error('');
    try {
      photo = await shrink(file);
      $('#rf-prev', s.body).innerHTML = `<img src="${URL.createObjectURL(photo)}" alt="The receipt you picked">`;
      $('#rf-pick-btn', s.body).firstChild.textContent = 'Change photo';
    } catch (err) { photo = null; s.error(err.message); }
  });
}

// ---------- One request ----------

export async function openRefund(id) {
  const r = RF.rows.find((x) => x.id === id);
  if (!r) return;
  const reviewer = isRefundReviewer();
  const owner = r.profile_id === S.user?.id;
  const s = openSheet({ title: `Refund · ${usd(r.amount)}` });
  const draw = (url) => {
    const cur = RF.rows.find((x) => x.id === id) || r;
    const c = cur.committee_id && team(cur.committee_id);
    const by = cur.status_by ? profile(cur.status_by)?.name : null;
    s.set(`<div class="form-error" role="alert"></div>
      <div class="rf-receipt">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Receipt for ${esc(cur.what_for)}"></a>` : '<span class="rf-ph">Loading the receipt…</span>'}</div>
      <div class="fsec plain">
        <div class="rf-status">${stTag(cur.status)}${cur.status_at ? `<span class="muted small-text">${esc(fmtStamp(cur.status_at))}${by ? ` by ${esc(by)}` : ''}</span>` : ''}</div>
        <dl class="rf-facts">
          <dt>Amount</dt><dd><b>${usd(cur.amount)}</b></dd>
          <dt>For</dt><dd>${esc(cur.what_for)}</dd>
          ${c ? `<dt>Committee</dt><dd>${esc(c.name)}</dd>` : ''}
          <dt>Pay back</dt><dd>${esc(cur.pay_to)}</dd>
          <dt>From</dt><dd>${esc(profile(cur.profile_id)?.name || (owner ? 'You' : 'Former member'))}</dd>
          <dt>Sent</dt><dd>${esc(fmtStamp(cur.created_at))}</dd>
        </dl>
      </div>
      ${reviewer ? `<div class="fsec plain"><h3>Status</h3><div class="seg rf-seg" role="radiogroup" aria-label="Status">${STATUSES.map((st) => `<button class="seg-b" type="button" role="radio" data-set="${st.key}" aria-checked="${st.key === cur.status}">${esc(st.label)}</button>`).join('')}</div>
        <p class="muted small-text">Processed means the money has been sent. The app doesn't send it.</p></div>` : ''}
      ${owner && cur.status === 'submitted' ? '<button class="btn quiet block danger-text" type="button" data-rf="withdraw">Withdraw this request</button>' : ''}`);
  };
  draw(null);
  draw(await receiptUrl(r.receipt_path));
  s.body.addEventListener('click', async (e) => {
    const set = e.target.closest('[data-set]')?.dataset.set;
    if (set) {
      if ((RF.rows.find((x) => x.id === id) || r).status === set) return;
      const row = await write(sb.rpc('refund_set_status', { p_id: id, p_status: set })).catch(() => null);
      if (!row) return;
      Object.assign(RF.rows.find((x) => x.id === id) || {}, row);
      toast(`Marked ${statusOf(set).label.toLowerCase()}.`);
      document.dispatchEvent(new CustomEvent('dash:refunds'));
      draw(await receiptUrl(r.receipt_path));
    }
    if (e.target.closest('[data-rf="withdraw"]')) {
      if (!(await confirmSheet('Withdraw this request?', `Your ${usd(r.amount)} request and its receipt photo are deleted.`, 'Withdraw'))) return;
      const del = await sb.from('refund_requests').delete().eq('id', id).select();
      if (del.error || !del.data?.length) { s.error(del.error ? del.error.message : 'It was already picked up for review, so it can’t be withdrawn.'); loadRefunds(); return; }
      await sb.storage.from('receipts').remove([r.receipt_path]);
      RF.rows = RF.rows.filter((x) => x.id !== id);
      document.dispatchEvent(new CustomEvent('dash:refunds'));
      s.close();
      toast('Request withdrawn.');
    }
  });
}
