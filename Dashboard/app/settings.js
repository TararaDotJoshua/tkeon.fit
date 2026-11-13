// The Settings screen, opened from the profile photo in the header: your
// profile, the admin screens (admins only), and sign out.

import { $, esc } from './ui.js';
import { S, avatar, isAdmin, teamChips, teamsOfProfile } from './store.js';
import { openProfile, signOut } from './auth.js';
import { manageClick, manageRows } from './admin.js';

const D = window.DASH;
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function renderSettings() {
  const el = $('#scene-settings');
  if (!el || el.hidden) return;
  const p = S.profile;
  if (!S.loaded) { el.innerHTML = '<p class="empty">Loading…</p>'; return; }
  if (!p) {
    el.innerHTML = `<div class="app-head"><h2>Settings</h2></div>
      <div class="app-note">Sign in with your FIT email and scroll number to set up your profile.<br><button class="btn primary small" type="button" data-act="signin">Sign in</button></div>`;
    return;
  }
  const teams = teamsOfProfile(p.id);
  el.innerHTML = `<div class="app-head"><h2>Settings</h2></div>
    <section class="panel set-card" aria-label="Your profile">
      <div class="profile-top">${avatar(p, 'lg')}<div><h3>${esc(p.name || 'No name yet')}</h3>
        <div class="muted">${p.grad_year ? `Class of ${esc(p.grad_year)}` : 'No graduation year yet'}${p.is_admin ? ' · Admin' : p.can_recruit ? ' · Recruitment' : ''}</div></div></div>
      ${teams.length ? teamChips(teams) : '<p class="muted small-text">No positions yet. An admin sets these.</p>'}
      <p class="muted small-text set-email">Signed in as ${esc(S.user.email)}</p>
      <div class="btn-row"><button class="btn" type="button" data-set="edit">Edit profile</button></div>
    </section>
    ${isAdmin() ? `<section class="panel set-card" aria-label="Manage chapter"><h3 class="eyebrow">Manage chapter</h3>${manageRows()}</section>` : ''}
    ${isIos() && !standalone() ? `<section class="panel set-card" aria-label="Add to Home Screen"><h3 class="eyebrow">Use it like an app</h3>
      <p class="small-text">In Safari, tap the Share button, then <b>Add to Home Screen</b>. The dashboard opens full screen with its own icon, and you stay signed in.</p></section>` : ''}
    <button class="btn danger block" type="button" data-set="signout">Sign out</button>`;
}

document.addEventListener('click', async (e) => {
  if (!e.target.closest('#scene-settings')) return;
  if (manageClick(e)) return;
  const act = e.target.closest('[data-set]')?.dataset.set;
  if (act === 'edit') openProfile(false);
  if (act === 'signout') { await signOut(); D.show('kras'); }
});
