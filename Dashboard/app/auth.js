// Sign-in (FIT email + scroll number), the first-sign-in profile screen, and
// the account sheet behind the avatar in the header.

import { $, esc, field, formData, friendly, openSheet, toast } from './ui.js';
import { S, sb, avatar, emit, load, scrollPassword, write } from './store.js';

const FIT_EMAIL = /^[a-z0-9._%+-]+@(my\.)?fit\.edu$/i;
export const needsProfile = () => Boolean(S.profile && (!S.profile.name || S.profile.grad_year == null));

// ---------- Header button ----------

export function renderAccount() {
  const slot = $('#account');
  if (!slot) return;
  slot.innerHTML = S.user && S.profile
    ? `<button class="acct-btn${window.DASH.scene() === 'settings' ? ' is-on' : ''}" type="button" data-act="account" aria-label="Settings and your account">${avatar(S.profile)}</button>`
    : `<button class="btn small" type="button" data-act="signin">Sign in</button>`;
}

document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'signin') openSignIn();
  if (act === 'account') window.DASH.show('settings');
});

// ---------- Session ----------

export async function initAuth() {
  const { data } = await sb.auth.getSession();
  S.user = data.session?.user || null;
  sb.auth.onAuthStateChange((event, session) => {
    const was = S.user?.id;
    S.user = session?.user || null;
    if (was !== S.user?.id) load();
  });
}

// ---------- Sign in / join ----------

export function openSignIn(after) {
  const s = openSheet({
    title: 'Sign in', primary: 'Continue',
    html: `<div class="form-error" role="alert"></div>
      <div class="fsec">
        ${field('FIT email', '<input class="input" name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="you@my.fit.edu" required>', 'Your @fit.edu or @my.fit.edu address.')}
        ${field('Scroll number', '<input class="input" name="scroll" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="current-password" maxlength="6" required>', 'The number you were given at initiation.')}
      </div>
      <p class="muted small-text">First time here? Enter the same two things and you\'ll set up your profile next.</p>`,
    onPrimary: async () => {
      const { email, scroll } = formData(s.body);
      if (!FIT_EMAIL.test(email)) return s.error('Use your @fit.edu or @my.fit.edu email.');
      if (!/^\d{1,6}$/.test(scroll)) return s.error('Enter your scroll number, digits only.');
      const { data: state, error } = await sb.rpc('signin_state', { p_email: email, p_scroll: scroll });
      if (error) throw error;
      if (state === 'bad_domain') return s.error('Use your @fit.edu or @my.fit.edu email.');
      if (state === 'unknown_scroll') return s.error("That scroll number isn't on the chapter scroll. Check it, or ask an admin.");
      if (state === 'scroll_claimed') return s.error('That scroll number is already linked to another email. Ask an admin to reset it.');
      const password = scrollPassword(scroll);
      if (state === 'has_account') {
        const res = await sb.auth.signInWithPassword({ email, password });
        if (res.error) return s.error(/invalid/i.test(res.error.message) ? "That scroll number doesn't match this email." : friendly(res.error));
        S.user = res.data.user;
      } else {
        const res = await sb.auth.signUp({ email, password, options: { data: { scroll } } });
        if (res.error || !res.data.session) return s.error("Couldn't create your account. Check your email and scroll number, or ask an admin.");
        S.user = res.data.user;
      }
      await load();
      s.close();
      if (S.profile?.disabled) toast('Your account is turned off. Ask an admin.');
      else if (needsProfile()) openProfile(true, after);
      else { toast(`Signed in as ${S.profile?.name || email}`); after?.(); }
    },
  });
  setTimeout(() => $('[name="email"]', s.body)?.focus(), 50);
}

// ---------- Profile (first sign-in and later edits) ----------

/** Shrink a photo to a 320px square JPEG. Smaller upload, and it drops the photo's location data. */
async function squarePhoto(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const side = Math.min(bmp.width, bmp.height), size = 320;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read that photo."))), 'image/jpeg', 0.85));
}

export function openProfile(first = false, after) {
  const p = S.profile;
  let photo = null; // a Blob once the member picks one
  const year = new Date().getFullYear();
  const s = openSheet({
    title: first ? 'Set up your profile' : 'Edit profile', primary: 'Save', closeLabel: first ? 'Later' : 'Cancel',
    html: `<div class="form-error" role="alert"></div>
      ${first ? '<p class="app-note">Welcome. Three quick things, then you\'re in.</p>' : ''}
      <div class="fsec">
        <div class="photo-pick">
          <span id="photo-preview">${avatar(p, 'lg')}</span>
          <label class="btn small">${p.avatar_path ? 'Change photo' : 'Add a photo'}<input type="file" name="photo" accept="image/*"></label>
        </div>
        ${field('Name', `<input class="input" name="name" autocomplete="name" autocapitalize="words" maxlength="80" value="${esc(p.name)}" required>`)}
        ${field('Year of graduation', `<input class="input" name="grad_year" type="number" inputmode="numeric" min="1950" max="2100" placeholder="${year + 2}" value="${esc(p.grad_year ?? '')}" required>`)}
      </div>
      <p class="muted small-text">Your name, year and photo are visible to anyone who opens the dashboard. Your email and scroll number are not.</p>`,
    onPrimary: async () => {
      const v = formData(s.body);
      const gy = Number(v.grad_year);
      if (!v.name) return s.error('Enter your name.');
      if (!Number.isInteger(gy) || gy < 1950 || gy > 2100) return s.error('Enter your graduation year, like 2027.');
      const patch = { name: v.name, grad_year: gy };
      if (photo) {
        const path = `${S.user.id}/${Date.now()}.jpg`;
        const up = await sb.storage.from('avatars').upload(path, photo, { contentType: 'image/jpeg', upsert: true });
        if (up.error) return s.error("Couldn't upload the photo. " + friendly(up.error));
        if (p.avatar_path) sb.storage.from('avatars').remove([p.avatar_path]); // tidy up the old one; fine if it fails
        patch.avatar_path = path;
      }
      await write(sb.from('profiles').update(patch).eq('id', S.user.id));
      await load();
      s.close();
      toast(first ? "You're all set." : 'Profile saved.');
      after?.();
    },
  });
  $('[name="photo"]', s.body).addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      photo = await squarePhoto(file);
      $('#photo-preview', s.body).innerHTML = `<span class="av lg"><img src="${URL.createObjectURL(photo)}" alt="Your new photo"></span>`;
    } catch (err) { photo = null; s.error("Couldn't read that photo. Try another one."); }
  });
}

export async function signOut() {
  await sb.auth.signOut();
  S.user = null;
  S.profile = null;
  emit();
  toast('Signed out.');
}

/** Run `fn` if signed in as a member; otherwise offer sign-in first. */
export function asMember(fn) {
  if (S.profile && !S.profile.disabled) return fn();
  if (S.profile?.disabled) return toast('Your account is turned off. Ask an admin.');
  openSignIn(fn);
}
