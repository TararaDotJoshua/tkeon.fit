// Start-up for the members' app: sign-in state, the Goals and Board screens, Recruitment, Settings.
// index.html loads this only in the members' view, never on the TV.

import { S, load, onChange } from './store.js';
import { initAuth, needsProfile, openProfile, renderAccount } from './auth.js';
import { openGoal, renderGoals } from './goals.js';
import { openIssue, renderBoard } from './board.js';
import { renderSettings } from './settings.js';
import { canRecruit, loadRecruit, openPnm, renderRecruit, resetRecruit } from './recruit.js';

const D = window.DASH;

let recruitFor = null; // whose recruitment data is loaded
function render() {
  renderAccount();
  D.setRecruit(canRecruit());
  // Load or drop recruitment data when who's signed in (or their access) changes.
  const who = canRecruit() ? S.user.id : null;
  if (who !== recruitFor) { recruitFor = who; resetRecruit(); if (who) loadRecruit(); }
  const scene = D.scene();
  if (scene === 'recruit') renderRecruit();
  if (scene === 'goals') renderGoals();
  if (scene === 'board') renderBoard();
  if (scene === 'settings') renderSettings();
}

onChange(render);
document.addEventListener('dash:scene', render);
// Opening the Recruitment tab fetches the latest PNMs (new interest forms arrive any time).
let recruitFetched = 0;
document.addEventListener('dash:scene', (e) => {
  if (e.detail === 'recruit' && canRecruit() && Date.now() - recruitFetched > 10e3) { recruitFetched = Date.now(); loadRecruit(); }
});
document.addEventListener('dash:data', () => { if (D.scene() === 'goals') renderGoals(); }); // goals that follow a KRA

// A link to one goal or issue, like #goals/<id> or #board/<id>, opens it.
let deepLinkDone = false;
function openDeepLink() {
  if (deepLinkDone || !S.loaded) return;
  deepLinkDone = true;
  const [scene, id] = location.hash.replace('#', '').split('/');
  if (!id) return;
  if (scene === 'goals') openGoal(id);
  if (scene === 'board') openIssue(id);
  if (scene === 'recruit' && canRecruit()) loadRecruit().then(() => openPnm(id));
}
onChange(openDeepLink);

await initAuth();
await load();
if (needsProfile()) openProfile(true);

// Stay fresh: when the app comes back to the front, and every minute while it's open.
let last = Date.now();
const refresh = () => { if (!document.hidden && !document.body.classList.contains('sheet-open')) { last = Date.now(); load(); if (canRecruit()) loadRecruit(); } };
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - last > 15e3) refresh(); });
window.addEventListener('online', refresh);
setInterval(() => { if (Date.now() - last > 60e3) refresh(); }, 20e3);
