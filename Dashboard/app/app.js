// Start-up for the members' app: sign-in state, the Goals and Board screens, Finances, Recruitment, Settings.
// index.html loads this only in the members' view, never on the TV.

import { S, isMember, load, onChange } from './store.js';
import { initAuth, needsProfile, openProfile, renderAccount } from './auth.js';
import { openGoal, renderGoals } from './goals.js';
import { openIssue, renderBoard } from './board.js';
import { renderSettings } from './settings.js';
import { canRecruit, loadRecruit, openPnm, renderRecruit, resetRecruit } from './recruit.js';
import { loadStudy, openOrgChart, openStudy, renderQuick, resetStudy } from './quick.js';
import { asMember } from './auth.js';
import { loadOpenNow, openCheckin, renderWeekExtra } from './checkin.js';
import { financeAge, loadFinance, renderFinance, resetFinance } from './finance.js';

const D = window.DASH;

let recruitFor = null; // whose recruitment data is loaded
let studyFor = null;   // whose study hours are loaded
let financeFor = null; // whose session the budget was loaded for
function render() {
  renderAccount();
  D.setRecruit(canRecruit());
  // Load or drop recruitment data when who's signed in (or their access) changes.
  const who = canRecruit() ? S.user.id : null;
  if (who !== recruitFor) { recruitFor = who; resetRecruit(); if (who) loadRecruit(); }
  // Study hours belong to whoever is signed in; drop them when that changes.
  const me = S.profile && !S.profile.disabled ? S.user.id : null;
  if (me !== studyFor) { studyFor = me; resetStudy(); }
  // The budget is for signed-in brothers only: drop it when they sign out.
  D.setMember(isMember());
  if (me !== financeFor) { financeFor = me; resetFinance(); }
  const scene = D.scene();
  if (scene === 'recruit') renderRecruit();
  if (scene === 'quick') renderQuick();
  if (scene === 'finance') renderFinance();
  renderWeekExtra(); // officers get the Past events button on This week
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
  if (e.detail === 'quick' && studyFor) loadStudy(); // hours logged on another device show up
  if (e.detail === 'finance' && financeFor && Date.now() - financeAge() > 30e3) loadFinance(); // the Sheet may have changed
  if (e.detail === 'quick' && studyFor) loadOpenNow(true).then(() => { if (D.scene() === 'quick') renderQuick(); }); // check-in just opened
});
document.addEventListener('dash:data', () => { if (D.scene() === 'goals') renderGoals(); }); // goals that follow a KRA

// A link to one goal or issue, like #goals/<id> or #board/<id>, opens it; #checkin opens Event check-in.
let deepLinkDone = false;
function openDeepLink() {
  if (deepLinkDone || !S.loaded) return;
  deepLinkDone = true;
  const [scene, id] = location.hash.replace('#', '').split('/');
  if (scene === 'checkin') { D.show('quick'); asMember(() => openCheckin(id || '')); return; } // tkeon.fit/Dashboard/#checkin(/K7QM)
  if (!id) return;
  if (scene === 'goals') openGoal(id);
  if (scene === 'board') openIssue(id);
  if (scene === 'recruit' && canRecruit()) loadRecruit().then(() => openPnm(id));
  if (scene === 'quick' && id === 'org') openOrgChart();
  if (scene === 'quick' && id === 'study') asMember(openStudy);
}
onChange(openDeepLink);
// A check-in link opened while the app is already running.
addEventListener('hashchange', () => {
  if (!/^#checkin\b/.test(location.hash)) return;
  const code = location.hash.split('/')[1] || '';
  D.show('quick');
  asMember(() => openCheckin(code));
});

await initAuth();
await load();
if (needsProfile()) openProfile(true);

// Stay fresh: when the app comes back to the front, and every minute while it's open.
let last = Date.now();
const refresh = () => { if (!document.hidden && !document.body.classList.contains('sheet-open')) { last = Date.now(); load(); if (canRecruit()) loadRecruit(); if (financeFor && D.scene() === 'finance') loadFinance(); } };
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - last > 15e3) refresh(); });
window.addEventListener('online', refresh);
setInterval(() => { if (Date.now() - last > 60e3) refresh(); }, 20e3);
