// Data for the Goals and Board screens: the Supabase client, what's loaded,
// and the few calculations both screens share.

import { clamp, dateOf, DAY, esc, friendly, toast } from './ui.js';

const D = window.DASH;
export const sb = window.supabase.createClient(D.config.supabaseUrl, D.config.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'tkeon-auth' },
});

/** The password Supabase stores for a scroll number (it needs 6+ characters). Matches private.scroll_password(). */
export const scrollPassword = (n) => `tkeon-scroll-${Number(n)}`;

export const S = {
  user: null,        // the signed-in account, or null
  profile: null,     // its public profile
  profiles: [], teams: [], profileTeams: [],
  goals: [], columns: [], issues: [], issueTeams: [], fields: [],
  loaded: false, error: null,
};

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
export const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

export const isMember = () => Boolean(S.profile && !S.profile.disabled);
export const isAdmin = () => Boolean(isMember() && S.profile.is_admin);

const all = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

let loading = null;
/** Load everything the two screens show. Small tables, so one pass is simplest. */
export function load() {
  loading ||= (async () => {
    try {
      const [profiles, teams, profileTeams, goals, columns, issues, issueTeams, fields] = await Promise.all([
        all(sb.from('profiles').select('*').order('name')),
        all(sb.from('teams').select('*').order('sort').order('name')),
        all(sb.from('profile_teams').select('*')),
        all(sb.from('goals').select('*').is('archived_at', null).order('due_date')),
        all(sb.from('board_columns').select('*').is('archived_at', null).order('sort')),
        all(sb.from('issues').select('*').is('archived_at', null).order('sort')),
        all(sb.from('issue_teams').select('*')),
        all(sb.from('custom_fields').select('*').is('archived_at', null).order('sort')),
      ]);
      Object.assign(S, { profiles, teams, profileTeams, goals, columns, issues, issueTeams, fields, loaded: true, error: null });
      S.profile = S.user ? profiles.find((p) => p.id === S.user.id) || null : null;
    } catch (e) {
      S.error = e;
    } finally {
      loading = null;
      emit();
    }
  })();
  return loading;
}

/** Run a write; on failure tell the member why and rethrow. */
export async function write(query) {
  const { data, error } = await query;
  if (error) { toast(friendly(error)); throw error; }
  return data;
}

// ---------- Lookups ----------

export const team = (id) => S.teams.find((t) => t.id === id);
export const activeTeams = () => S.teams.filter((t) => !t.archived_at);
export const profile = (id) => S.profiles.find((p) => p.id === id);
export const teamsOfIssue = (id) => S.issueTeams.filter((x) => x.issue_id === id).map((x) => team(x.team_id)).filter(Boolean);
export const teamsOfProfile = (id) => S.profileTeams.filter((x) => x.profile_id === id).map((x) => team(x.team_id)).filter(Boolean);
export const kras = () => (D.data()?.kras || []).filter((k) => k.section === 'kra');
export const column = (id) => S.columns.find((c) => c.id === id);
export const issuesOfGoal = (id) => S.issues.filter((i) => i.goal_id === id);

export const avatarUrl = (p) => (p?.avatar_path ? `${D.config.supabaseUrl}/storage/v1/object/public/avatars/${p.avatar_path}` : null);
export function avatar(p, size = '') {
  const url = avatarUrl(p);
  const initials = (p?.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  return `<span class="av ${size}"${url ? '' : ' aria-hidden="true"'}>${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : esc(initials)}</span>`;
}
export const teamChips = (teams) => (teams.length ? `<span class="chips">${teams.map((t) => `<span class="chip">${esc(t.name)}</span>`).join('')}</span>` : '');
export const statusTag = (st) => `<span class="st">${D.icons[st.key]}<span>${esc(st.label)}</span></span>`;

// ---------- Goals ----------

const UNIT_OF_KIND = { currency: 'currency', boolean: 'boolean', number: 'number' };
export const unitOfKra = (k) => UNIT_OF_KIND[k?.kind] || 'number';

/** Everything the screens need to draw a goal: its value, progress, pace and status. */
export function goalView(g, now = Date.now()) {
  const kra = g.kra_id ? kras().find((k) => k.id === g.kra_id) || null : null;
  const start = Number(g.start_value), target = Number(g.target_value);
  const cur = kra ? (kra.current == null ? null : Number(kra.current)) : Number(g.current_value ?? g.start_value);
  const span = target - start;
  const pct = cur == null ? 0 : span === 0 ? (cur === target ? 1 : 0) : clamp((cur - start) / span, 0, 1);
  const s = dateOf(g.start_date).getTime(), e = dateOf(g.due_date).getTime() + DAY - 1000;
  const pace = clamp((now - s) / Math.max(1, e - s), 0, 1);
  const met = cur != null && (span >= 0 ? cur >= target : cur <= target);
  let status;
  if (g.status === 'dropped') status = { key: 'none', label: 'Dropped' };
  else if (g.status === 'achieved' || met) status = { key: 'met', label: 'Achieved' };
  else if (now > e) status = { key: 'behind', label: 'Overdue' };
  else if (pct + 0.02 >= pace) status = { key: 'ontrack', label: 'On pace' };
  else status = { key: 'behind', label: 'Behind pace' };
  const open = g.status === 'active' && !met;
  return { kra, cur, pct, pace: open ? pace : null, status, open, daysLeft: Math.ceil((e - now) / DAY) };
}

/** Where a card dropped between two others should sort. */
export function sortBetween(prev, next) {
  if (prev == null && next == null) return 1024;
  if (prev == null) return next - 1024;
  if (next == null) return prev + 1024;
  return (prev + next) / 2;
}
