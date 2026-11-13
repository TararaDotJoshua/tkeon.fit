// Small UI helpers shared by the Goals, Board, sign-in and admin screens.
// Everything a person typed goes through esc() before it reaches the page.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const DAY = 864e5;

// ---------- Dates and numbers ----------

/** 'YYYY-MM-DD' -> local midnight, so a due date never shifts with the time zone. */
export const dateOf = (ymd) => { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
export const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
export const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const fmtDate = (v) => {
  const d = dateOf(v);
  return d.toLocaleDateString('en-US', d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
};
export const fmtStamp = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const daysUntil = (v) => Math.round((dateOf(v) - today()) / DAY);
export const fmtNum = (n, max = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: max });
export function fmtVal(unit, n) {
  if (n == null || n === '') return '–';
  if (unit === 'boolean') return Number(n) ? 'Done' : 'Not done';
  if (unit === 'currency') return '$' + fmtNum(n);
  if (unit === 'percent') return fmtNum(n) + '%';
  return fmtNum(n);
}
/** Only http and https links are ever shown as links. */
export const safeUrl = (u) => (/^https?:\/\/\S+$/i.test(String(u || '').trim()) ? String(u).trim() : null);
/** What a person typed into a link box -> a clean http(s) address, or null. "docs.google.com/x" gets https:// added. */
export function cleanUrl(raw) {
  const t = String(raw || '').trim();
  if (!t || /\s/.test(t)) return null;
  if (!/^https?:\/\//i.test(t) && t.includes('@')) return null; // an email address, not a page
  const scheme = t.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^https?$/i.test(scheme[1]) && !/^[^/]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(t)) return null; // javascript:, data:, mailto: ...
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    return /^https?:$/.test(u.protocol) && /\.[a-z]{2,}$/i.test(u.hostname) ? u.href : null;
  } catch { return null; }
}
export const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'link'; } };

// ---------- Toast ----------

let toastTimer = 0;
export function toast(message) {
  $('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3800);
}

// ---------- Sheets ----------
// A sheet slides up to nearly full height on a phone and is a centred dialog on
// a desktop. "Cancel" is top left and the main action top right, as in iOS, so
// both stay visible while the keyboard is up.

const stack = [];

/**
 * @param {{title: string, html?: string, primary?: string, closeLabel?: string, small?: boolean,
 *          onPrimary?: (sheet) => (void|Promise<void>), onClose?: () => void}} opts
 */
export function openSheet(opts) {
  const back = document.createElement('div');
  back.className = 'sheet-back';
  back.innerHTML = `<div class="sheet${opts.small ? ' small' : ''}" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
    <header class="sheet-head">
      <button class="btn quiet small" type="button" data-sheet="close">${esc(opts.closeLabel || (opts.primary ? 'Cancel' : 'Close'))}</button>
      <div class="sheet-title">${esc(opts.title)}</div>
      ${opts.primary ? `<button class="btn primary small" type="button" data-sheet="primary">${esc(opts.primary)}</button>` : '<span class="sheet-spacer"></span>'}
    </header>
    <form class="sheet-body" novalidate></form>
  </div>`;
  const body = $('.sheet-body', back);
  const sheet = {
    el: back,
    body,
    closed: false,
    set(html) { body.innerHTML = html; },
    title(t) { $('.sheet-title', back).textContent = t; },
    error(msg) { const box = $('.form-error', body); if (box) { box.textContent = msg || ''; if (msg) box.scrollIntoView({ block: 'nearest' }); } else if (msg) toast(msg); },
    busy(on) { const b = $('[data-sheet="primary"]', back); if (b) b.disabled = on; },
    close() {
      if (sheet.closed) return;
      sheet.closed = true;
      back.remove();
      stack.splice(stack.indexOf(sheet), 1);
      if (!stack.length) document.body.classList.remove('sheet-open');
      opts.onClose?.();
    },
  };
  const submit = async () => {
    if (!opts.onPrimary || $('[data-sheet="primary"]', back)?.disabled) return;
    sheet.error('');
    sheet.busy(true);
    try { await opts.onPrimary(sheet); } catch (e) { sheet.error(friendly(e)); } finally { if (!sheet.closed) sheet.busy(false); }
  };
  back.addEventListener('click', (e) => {
    if (e.target === back && !opts.primary) return sheet.close(); // tap outside closes read-only sheets, never a form
    const act = e.target.closest('[data-sheet]')?.dataset.sheet;
    if (act === 'close') sheet.close();
    if (act === 'primary') submit();
  });
  body.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); sheet.close(); } });
  if (opts.html != null) sheet.set(opts.html);
  document.body.appendChild(back);
  document.body.classList.add('sheet-open');
  stack.push(sheet);
  return sheet;
}

export const closeAllSheets = () => [...stack].forEach((s) => s.close());

/** A small yes/no sheet. Resolves true when the person confirms. */
export function confirmSheet(title, message, action = 'Confirm') {
  return new Promise((resolve) => {
    let yes = false;
    const s = openSheet({
      title, small: true, primary: action,
      html: `<p class="prose">${esc(message)}</p>`,
      onPrimary: () => { yes = true; s.close(); },
      onClose: () => resolve(yes),
    });
  });
}

/** Turn a database or network error into a sentence a member can act on. */
export function friendly(err) {
  const m = String(err?.message || err || '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Couldn't reach the server. Check your connection and try again.";
  if (/row-level security|permission denied|42501/i.test(m) || err?.code === '42501') return "You don't have permission to do that. Sign in, or ask an admin.";
  if (/due_date|goals_check/i.test(m)) return 'The due date must be on or after the start date.';
  if (/valid_links|links_check/i.test(m)) return 'Links must start with http:// or https://.';
  if (/JWT|token|session/i.test(m)) return 'Your sign-in expired. Sign in again.';
  return m || 'Something went wrong. Try again.';
}

// ---------- Form helpers ----------

/** Read every named control in a form into a plain object. */
export function formData(form) {
  const out = {};
  for (const el of $$('[name]', form)) {
    if (el.type === 'checkbox') {
      if (el.dataset.multi != null) (out[el.name] ||= []).push(...(el.checked ? [el.value] : []));
      else out[el.name] = el.checked;
    } else if (el.type !== 'file') out[el.name] = el.value.trim();
  }
  return out;
}
export const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
export const opt = (value, label, selected) => `<option value="${esc(value)}"${String(selected ?? '') === String(value) ? ' selected' : ''}>${esc(label)}</option>`;
export const field = (label, control, hint = '') => `<label class="field"><span class="lab">${esc(label)}</span>${control}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
