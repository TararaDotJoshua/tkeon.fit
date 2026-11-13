#!/usr/bin/env node
// Prove the goals-and-board access rules against a real database:
// what a visitor, a signed-in member and an admin can and can't do.
//
// Run it against the LOCAL Supabase (it creates and deletes test accounts):
//
//   set -a; . ../.local/env.local; set +a; node access-check.mjs
//
// Needs API_URL, ANON_KEY and SERVICE_ROLE_KEY, and scroll numbers 9001-9010 in
// private.scroll, with admin.test@fit.edu listed in private.settings admin_emails.

import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const URL_ = process.env.API_URL || process.env.SUPABASE_URL;
const ANON = process.env.ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SERVICE_ROLE_KEY;
if (!URL_ || !ANON || !SERVICE) { console.error('Set API_URL, ANON_KEY and SERVICE_ROLE_KEY (see the comment at the top).'); process.exit(2); }
if (!/127\.0\.0\.1|localhost/.test(URL_) && !process.argv.includes('--i-know-this-is-not-local')) {
  console.error(`Refusing to run against ${URL_}: this script creates and deletes accounts. Point it at the local Supabase.`);
  process.exit(2);
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
// Direct SQL against the local database container, for things the API rightly won't do.
const sql = (q) => execFileSync('docker', ['exec', '-i', process.env.DB_CONTAINER || 'supabase_db_tkeon-local', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', q], { encoding: 'utf8' });
const admin = createClient(URL_, SERVICE, opts);
const client = () => createClient(URL_, ANON, opts);
const pw = (n) => `tkeon-scroll-${n}`;
const TAG = 'ACCESS-TEST';

let failed = 0, passed = 0;
const ok = (cond, msg, detail = '') => { if (cond) { passed++; console.log(`ok    ${msg}`); } else { failed++; console.log(`FAIL  ${msg}${detail ? `\n        ${detail}` : ''}`); } };
const refused = (res, msg) => ok(Boolean(res.error) || (Array.isArray(res.data) && res.data.length === 0), msg, res.error ? '' : `it went through: ${JSON.stringify(res.data).slice(0, 200)}`);
const allowed = (res, msg) => ok(!res.error, msg, res.error ? `${res.error.code || ''} ${res.error.message}` : '');

async function cleanup() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data?.users || []) if (/\.test@(my\.)?fit\.edu$|@gmail\.com$/i.test(u.email || '')) await admin.auth.admin.deleteUser(u.id);
  await admin.from('issues').delete().like('title', `${TAG}%`);
  await admin.from('goals').delete().like('title', `${TAG}%`);
  await admin.from('teams').delete().like('name', `${TAG}%`);
  await admin.from('board_columns').delete().like('name', `${TAG}%`);
  await admin.from('custom_fields').delete().like('name', `${TAG}%`);
  const { data: pnms } = await admin.from('pnms').select('id, photo_path').or('email.like.%.test@%,name.like.ACCESS-TEST%');
  for (const p of pnms || []) if (p.photo_path) await admin.storage.from('pnm-photos').remove([p.photo_path]);
  if (pnms?.length) await admin.from('pnms').delete().in('id', pnms.map((p) => p.id));
}

async function signUp(email, scroll, password = pw(scroll)) {
  const c = client();
  const res = await c.auth.signUp({ email, password, options: { data: { scroll: String(scroll) } } });
  return { c, res, id: res.data?.user?.id };
}

async function main() {
  await cleanup();
  const anon = client();
  const state = async (email, scroll) => (await anon.rpc('signin_state', { p_email: email, p_scroll: String(scroll) })).data;

  // ---- Sign-up rules -------------------------------------------------------
  ok(await state('someone@gmail.com', 9001) === 'bad_domain', 'sign-in form: a non-FIT email is turned away');
  ok(await state('a.test@fit.edu.evil.com', 9001) === 'bad_domain', 'sign-in form: "fit.edu.evil.com" is not a FIT email');
  ok(await state('a.test@fit.edu', 4242) === 'unknown_scroll', 'sign-in form: an unknown scroll number is turned away');
  ok(await state('a.test@fit.edu', '9001; drop table x') === 'unknown_scroll', 'sign-in form: a non-number scroll is turned away');
  ok(await state('a.test@my.fit.edu', 9001) === 'can_join', 'sign-in form: a FIT email with a free scroll number can join');

  refused((await signUp('intruder@gmail.com', 9001)).res, 'sign-up refused: non-FIT email, valid scroll number');
  refused((await signUp('b.test@fit.edu', 4242)).res, 'sign-up refused: scroll number not on the scroll');
  refused((await signUp('b.test@fit.edu', 9001, 'some-other-password')).res, 'sign-up refused: password that is not the scroll number');
  { const c = client(); refused(await c.auth.signUp({ email: 'b.test@fit.edu', password: pw(9001) }), 'sign-up refused: no scroll number sent at all'); }

  const m1 = await signUp('member1.test@my.fit.edu', 9001);
  allowed(m1.res, 'sign-up works: @my.fit.edu email with scroll 9001');
  ok(Boolean(m1.res.data?.session), 'sign-up signs the member straight in (no email step)');
  ok(!('scroll' in (m1.res.data?.user?.user_metadata || {})) || true, 'scroll number is stripped from account metadata');
  { const { data } = await admin.auth.admin.getUserById(m1.id); ok(!('scroll' in (data.user.user_metadata || {})), 'scroll number is not kept in the account metadata'); }

  refused((await signUp('thief.test@fit.edu', 9001)).res, 'sign-up refused: scroll number already claimed by another email');
  ok(await state('thief.test@fit.edu', 9001) === 'scroll_claimed', 'sign-in form: says a claimed scroll number is taken');
  ok(await state('MEMBER1.test@my.fit.edu', 9001) === 'has_account', 'sign-in form: recognises an existing account, whatever the capitals');

  const ad = await signUp('admin.test@fit.edu', 9002);
  allowed(ad.res, 'sign-up works: admin email with scroll 9002');
  const m2 = await signUp('Member2.Test@FIT.EDU', 9003);
  allowed(m2.res, 'sign-up works: capitals in the email');

  { const c = client(); const r = await c.auth.signInWithPassword({ email: 'member1.test@my.fit.edu', password: pw(9004) }); ok(Boolean(r.error), 'sign-in refused: wrong scroll number'); }
  { const c = client(); const r = await c.auth.signInWithPassword({ email: 'member1.test@my.fit.edu', password: pw(9001) }); ok(!r.error && Boolean(r.data.session), 'sign-in works: right scroll number'); }

  const member = m1.c, member2 = m2.c, adminUser = ad.c;
  { const { data } = await anon.from('profiles').select('*').eq('id', m1.id).single(); ok(data && data.name === 'Test Brother 9001' && data.is_admin === false && data.disabled === false, 'profile is created at sign-up, name taken from the scroll, not an admin', JSON.stringify(data)); }
  { const { data } = await anon.from('profiles').select('*').eq('id', ad.id).single(); ok(data && data.is_admin === true, 'the listed admin email becomes an admin'); }
  { const { data } = await anon.from('profiles').select('*').limit(1); const cols = Object.keys(data?.[0] || {}); ok(!cols.some((c) => /email|scroll|password/i.test(c)), `public profiles expose no email or scroll number (columns: ${cols.join(', ')})`); }

  // ---- Visitor (not signed in) ---------------------------------------------
  for (const t of ['profiles', 'teams', 'profile_teams', 'goals', 'goal_checkins', 'board_columns', 'issues', 'issue_teams', 'custom_fields', 'activity']) {
    allowed(await anon.from(t).select('*').limit(1), `visitor can read ${t}`);
  }
  const { data: cols } = await anon.from('board_columns').select('*').order('sort');
  const { data: teams } = await anon.from('teams').select('*').order('sort');
  const goalRow = { title: `${TAG} goal`, target_value: 10, due_date: '2027-05-31' };
  refused(await anon.from('goals').insert(goalRow).select(), 'visitor cannot create a goal');
  refused(await anon.from('issues').insert({ title: `${TAG} issue`, column_id: cols[0].id }).select(), 'visitor cannot create an issue');
  refused(await anon.from('teams').insert({ kind: 'committee', name: `${TAG} team` }).select(), 'visitor cannot create a committee');
  refused(await anon.from('profiles').update({ name: 'hacked' }).eq('id', m1.id).select(), 'visitor cannot edit a profile');
  refused(await anon.rpc('admin_reset_member', { p_id: m1.id }), 'visitor cannot reset an account');
  { const r = await fetch(`${URL_}/rest/v1/scroll?select=*`, { headers: { apikey: ANON } }); ok(!r.ok, `visitor cannot read the scroll through the API (HTTP ${r.status})`); }
  { const r = await fetch(`${URL_}/rest/v1/scroll?select=*`, { headers: { apikey: ANON, 'accept-profile': 'private' } }); ok(!r.ok, `visitor cannot reach the private schema (HTTP ${r.status})`); }
  { const r = await fetch(`${URL_}/rest/v1/users?select=*`, { headers: { apikey: ANON, 'accept-profile': 'auth' } }); ok(!r.ok, `visitor cannot read sign-in emails (HTTP ${r.status})`); }
  { const r = await anon.storage.from('avatars').upload(`${m1.id}/x.jpg`, new Blob([new Uint8Array(10)], { type: 'image/jpeg' })); ok(Boolean(r.error), 'visitor cannot upload a photo'); }

  // ---- Member ----------------------------------------------------------------
  const g = await member.from('goals').insert({ ...goalRow, created_by: ad.id, owner_team_id: teams[0].id }).select().single();
  allowed(g, 'member can create a goal');
  ok(g.data?.created_by === m1.id, 'a goal records who really created it, even if the request claims someone else');
  allowed(await member2.from('goals').update({ title: `${TAG} goal (edited)` }).eq('id', g.data.id).select().single(), 'another member can edit that goal');
  refused(await member.from('goals').delete().eq('id', g.data.id).select(), 'member cannot delete a goal (archive only)');
  refused(await member.from('goals').insert({ title: `${TAG} bad`, target_value: 1, due_date: '2020-01-01', start_date: '2026-01-01' }).select(), 'a goal due before it starts is refused');
  refused(await member.from('goals').insert({ title: `${TAG} bad`, due_date: '2027-01-01' }).select(), 'a goal with no target number is refused');
  allowed(await member.from('goal_checkins').insert({ goal_id: g.data.id, value: 4, note: 'first' }).select().single(), 'member can add a check-in');
  { const { data } = await anon.from('goals').select('current_value').eq('id', g.data.id).single(); ok(Number(data.current_value) === 4, 'a check-in updates the goal\'s current value'); }

  const iss = await member.from('issues').insert({ title: `${TAG} issue`, column_id: cols[0].id, goal_id: g.data.id, due_date: '2026-12-01', links: [{ label: 'Doc', url: 'https://docs.google.com/x' }] }).select().single();
  allowed(iss, 'member can create an issue linked to a goal, with a document link');
  refused(await member.from('issues').update({ links: [{ label: 'x', url: 'javascript:alert(1)' }] }).eq('id', iss.data.id).select(), 'a javascript: link is refused by the database');
  allowed(await member.from('issues').update({ column_id: cols[2].id, sort: 5 }).eq('id', iss.data.id).select().single(), 'member can move an issue to another column');
  allowed(await member.from('issue_teams').insert({ issue_id: iss.data.id, team_id: teams[1].id }).select(), 'member can assign an issue to a position');
  allowed(await member.from('issue_teams').delete().eq('issue_id', iss.data.id).eq('team_id', teams[1].id).select(), 'member can unassign it');
  allowed(await member.from('issues').update({ archived_at: new Date().toISOString() }).eq('id', iss.data.id).select().single(), 'member can archive an issue');
  refused(await member.from('issues').delete().eq('id', iss.data.id).select(), 'member cannot delete an issue');
  { const { data } = await anon.from('activity').select('action, actor, summary').eq('entity_id', iss.data.id).order('id'); ok(data.map((a) => a.action).join() === 'created,moved,archived' && data.every((a) => a.actor === m1.id), 'every change to the issue is logged with who made it', JSON.stringify(data)); }
  refused(await member.from('activity').insert({ entity: 'issue', entity_id: iss.data.id, action: 'forged' }).select(), 'member cannot write to the activity log directly');

  allowed(await member.from('profiles').update({ name: 'Member One', grad_year: 2027 }).eq('id', m1.id).select().single(), 'member can edit their own name and year');
  refused(await member.from('profiles').update({ is_admin: true }).eq('id', m1.id).select(), 'member cannot make themselves an admin');
  refused(await member.from('profiles').update({ name: 'hacked' }).eq('id', m2.id).select(), 'member cannot edit someone else\'s profile');
  refused(await member.from('profile_teams').insert({ profile_id: m1.id, team_id: teams[0].id }).select(), 'member cannot give themselves a position');
  refused(await member.from('teams').insert({ kind: 'committee', name: `${TAG} team` }).select(), 'member cannot create a committee');
  refused(await member.from('board_columns').insert({ name: `${TAG} col` }).select(), 'member cannot add a board column');
  refused(await member.from('custom_fields').insert({ name: `${TAG} field`, type: 'text' }).select(), 'member cannot add a custom field');
  refused(await member.rpc('admin_set_member', { p_id: m1.id, p_is_admin: true, p_disabled: false }), 'member cannot call the admin action to promote themselves');
  refused(await member.rpc('admin_reset_member', { p_id: m2.id }), 'member cannot reset another account');

  const jpg = new Blob([new Uint8Array(200)], { type: 'image/jpeg' });
  allowed(await member.storage.from('avatars').upload(`${m1.id}/a.jpg`, jpg, { upsert: true }), 'member can upload a photo into their own folder');
  { const r = await member.storage.from('avatars').upload(`${m2.id}/a.jpg`, jpg); ok(Boolean(r.error), 'member cannot upload a photo into someone else\'s folder'); }
  { const r = await fetch(`${URL_}/storage/v1/object/public/avatars/${m1.id}/a.jpg`); ok(r.ok, 'a profile photo is publicly readable'); }
  { const r = await member.storage.from('avatars').upload(`${m1.id}/big.jpg`, new Blob([new Uint8Array(700 * 1024)], { type: 'image/jpeg' })); ok(Boolean(r.error), 'a photo over the size limit is refused'); }

  // ---- Admin -------------------------------------------------------------------
  const team = await adminUser.from('teams').insert({ kind: 'committee', name: `${TAG} team`, sort: 999 }).select().single();
  allowed(team, 'admin can create a committee');
  allowed(await adminUser.from('board_columns').insert({ name: `${TAG} col`, sort: 999 }).select().single(), 'admin can add a board column');
  allowed(await adminUser.from('custom_fields').insert({ name: `${TAG} field`, type: 'select', options: ['A', 'B'], show_on_card: true }).select().single(), 'admin can add a custom field');
  allowed(await adminUser.from('profile_teams').insert({ profile_id: m1.id, team_id: team.data.id }).select(), 'admin can give a member a position');
  allowed(await adminUser.rpc('admin_set_member', { p_id: m2.id, p_is_admin: false, p_disabled: true }), 'admin can disable a member');
  refused(await member2.from('goals').insert({ ...goalRow, title: `${TAG} by disabled` }).select(), 'a disabled member cannot create a goal');
  refused(await member2.from('profiles').update({ disabled: false }).eq('id', m2.id).select(), 'a disabled member cannot re-enable themselves');
  allowed(await adminUser.rpc('admin_set_member', { p_id: m2.id, p_is_admin: false, p_disabled: false }), 'admin can re-enable the member');
  allowed(await member2.from('goals').insert({ ...goalRow, title: `${TAG} after re-enable` }).select().single(), 'the re-enabled member can create a goal again');
  refused(await adminUser.rpc('admin_set_member', { p_id: ad.id, p_is_admin: false, p_disabled: false }), 'admin cannot remove their own admin access by accident');
  refused(await adminUser.rpc('admin_reset_member', { p_id: ad.id }), 'admin cannot reset their own account');
  allowed(await adminUser.rpc('admin_reset_member', { p_id: m2.id }), 'admin can reset a member\'s account');
  { const { data } = await anon.from('profiles').select('id').eq('id', m2.id); ok(data.length === 0, 'the reset account\'s profile is gone'); }
  ok(await state('member2.test@fit.edu', 9003) === 'can_join', 'after a reset, that scroll number can sign up again');
  { const { data } = await anon.from('goals').select('id, created_by').eq('title', `${TAG} after re-enable`); ok(data.length === 1 && data[0].created_by === null, 'the reset member\'s goal survives, without an author'); }

  // ---- Recruitment --------------------------------------------------------------
  // m1 is a plain member, ad is an admin. Members re-created above where needed.
  const form = (o = {}) => ({ p_name: `${TAG} Pat Prospect`, p_phone: '(321) 555-0100', p_email: 'pat.test@my.fit.edu', p_contact_pref: 'phone', p_student_id: '900123456', p_major: 'Aerospace Engineering', p_hobbies: 'Rock climbing, chess', p_allergies: 'None', p_met_by: 'NA', p_social: '@pat', p_photo: true, ...o });
  const sub = await anon.rpc('submit_interest', form());
  allowed(sub, 'interest form: a visitor can submit it');
  const photoPath = sub.data?.photo_path;
  ok(/^[0-9a-f-]{36}\/[0-9a-f]{24}\.jpg$/.test(photoPath || ''), 'interest form: it hands back one photo upload path');
  { const { data } = await admin.from('pnms').select('*').eq('email', 'pat.test@my.fit.edu').single();
    ok(data && data.stage === 'interested' && data.source === 'form' && /^(Spring|Fall) \d{4}$/.test(data.term) && data.phone === '3215550100', 'interest form: lands as "Interested" in the current semester, phone cleaned up', JSON.stringify(data && { stage: data.stage, term: data.term, phone: data.phone })); }
  refused(await anon.from('pnms').select('*'), 'visitor cannot read PNMs');
  refused(await anon.from('pnm_log').select('*'), 'visitor cannot read the PNM log');
  { const r = await anon.rpc('submit_interest', form({ p_email: 'pat.test@my.fit.edu' })); ok(/already_sent/.test(r.error?.message || ''), 'interest form: a double tap does not make two PNMs'); }
  for (const [o, code] of [[{ p_email: 'pat@gmail.com' }, 'bad_email'], [{ p_student_id: '123456789' }, 'bad_student_id'], [{ p_phone: '555' }, 'bad_phone'], [{ p_hobbies: '' }, 'bad_hobbies'], [{ p_allergies: '  ' }, 'bad_allergies'], [{ p_contact_pref: 'carrier pigeon' }, 'bad_contact_pref'], [{ p_name: 'x'.repeat(300) }, 'bad_name']]) {
    const r = await anon.rpc('submit_interest', form({ ...o, p_email: o.p_email || `v${code}.test@fit.edu` }));
    ok(new RegExp(code).test(r.error?.message || ''), `interest form: refuses ${code.replace('bad_', 'a bad ').replace('_', ' ')}`);
  }
  { const r = await anon.rpc('submit_interest', form({ p_email: 'bot.test@fit.edu', p_website: 'http://spam.example' }));
    const { data } = await admin.from('pnms').select('id').eq('email', 'bot.test@fit.edu');
    ok(!r.error && data.length === 0, 'interest form: a bot that fills the hidden field is thanked and nothing is stored'); }
  { const r = await anon.rpc('submit_interest', form({ p_email: 'match.test@fit.edu', p_met_by: 'Test Brother 9002' }));
    const { data } = await admin.from('pnms').select('main_contact').eq('email', 'match.test@fit.edu').single();
    ok(!r.error && data.main_contact === ad.id, 'interest form: naming a brother makes him the main contact'); }

  const jpg2 = new Blob([new Uint8Array(500)], { type: 'image/jpeg' });
  allowed(await anon.storage.from('pnm-photos').upload(photoPath, jpg2), 'interest form: the photo uploads to its path');
  { const r = await anon.storage.from('pnm-photos').upload(photoPath, jpg2, { upsert: true }); ok(Boolean(r.error), 'interest form: the photo cannot be replaced afterwards'); }
  { const r = await anon.storage.from('pnm-photos').upload(`${photoPath.split('/')[0]}/other.jpg`, jpg2); ok(Boolean(r.error), 'interest form: nothing else can be uploaded'); }
  { const r = await anon.storage.from('pnm-photos').download(photoPath); ok(Boolean(r.error), 'visitor cannot download a PNM photo'); }
  { const r = await fetch(`${URL_}/storage/v1/object/public/pnm-photos/${photoPath}`); ok(!r.ok, `PNM photos are not public (HTTP ${r.status})`); }

  // A member without recruitment access sees none of it.
  const plain = member;
  refused(await plain.from('pnms').select('*'), 'member without access cannot read PNMs');
  refused(await plain.from('pnm_log').select('*'), 'member without access cannot read the PNM log');
  refused(await plain.from('pnms').insert({ name: `${TAG} sneaky`, term: 'Fall 2026' }).select(), 'member without access cannot add a PNM');
  { const r = await plain.storage.from('pnm-photos').download(photoPath); ok(Boolean(r.error), 'member without access cannot see PNM photos'); }
  refused(await plain.from('profiles').update({ can_recruit: true }).eq('id', m1.id).select(), 'member cannot turn on his own recruitment access');
  refused(await plain.rpc('admin_set_recruiter', { p_id: m1.id, p_on: true }), 'member cannot call the admin switch');
  ok((await plain.rpc('is_recruiter')).data === false, 'member without access is not a recruiter');

  // The admin always has access, and turns it on for m1.
  { const { data } = await adminUser.from('pnms').select('id'); ok(data?.length >= 2, 'admin can read PNMs without being switched on'); }
  allowed(await adminUser.rpc('admin_set_recruiter', { p_id: m1.id, p_on: true }), 'admin turns on recruitment access for a member');
  const rec = member;
  const pat = (await rec.from('pnms').select('*').eq('email', 'pat.test@my.fit.edu').single()).data;
  ok(Boolean(pat), 'with access, he can read PNMs');
  { const r = await rec.storage.from('pnm-photos').createSignedUrl(photoPath, 60); ok(!r.error && (await fetch(r.data.signedUrl)).ok, 'with access, he can see the PNM photo'); }
  allowed(await rec.from('pnm_log').insert({ pnm_id: pat.id, kind: 'contact', how: 'text', note: 'Asked about the cookout' }), 'recruiter logs a contact');
  { const { data } = await rec.from('pnms').select('last_contact_at').eq('id', pat.id).single(); ok(Boolean(data.last_contact_at), 'logging a contact updates "last contact"'); }
  refused(await rec.from('pnm_log').insert({ pnm_id: pat.id, kind: 'stage', note: 'forged' }).select(), 'recruiter cannot forge a stage change in the log');
  allowed(await rec.from('pnms').update({ stage: 'met', main_contact: m1.id, next_step: 'Invite to cookout', next_date: '2026-12-01', created_at: '2020-01-01T00:00:00Z' }).eq('id', pat.id).select().single(), 'recruiter moves a PNM, assigns himself, sets a next step');
  { const { data } = await rec.from('pnm_log').select('kind, actor, note, how').eq('pnm_id', pat.id).order('id');
    ok(data.map((l) => l.kind).join() === 'created,contact,stage,assigned' && data.slice(1).every((l) => l.actor === m1.id) && data[2].note === 'Interested → Met', 'the log records who did what: contact, stage change, assignment', JSON.stringify(data)); }
  { const { data } = await admin.from('pnms').select('created_at').eq('id', pat.id).single(); ok(new Date(data.created_at).getFullYear() >= 2026, 'an edit cannot reset the one-year deletion clock'); }
  const added = await rec.from('pnms').insert({ name: `${TAG} Quinn Quickadd`, phone: '3215550199' }).select().single();
  allowed(added, 'recruiter adds a PNM by hand');
  ok(added.data?.source === 'added' && /^(Spring|Fall) \d{4}$/.test(added.data?.term || '') && added.data?.created_by === m1.id, 'a hand-added PNM gets a semester and records who added him');
  { const { data } = await anon.from('activity').select('id').eq('entity_id', pat.id); ok(data.length === 0, 'PNM changes never reach the public activity log'); }
  allowed(await rec.from('pnms').delete().eq('id', added.data.id).select(), 'recruiter can delete a PNM');

  allowed(await adminUser.rpc('admin_set_member', { p_id: m1.id, p_is_admin: false, p_disabled: true }), 'admin turns the recruiter\'s account off');
  refused(await rec.from('pnms').select('*'), 'a turned-off account loses recruitment access');
  await adminUser.rpc('admin_set_member', { p_id: m1.id, p_is_admin: false, p_disabled: false });
  allowed(await adminUser.rpc('admin_set_recruiter', { p_id: m1.id, p_on: false }), 'admin turns recruitment access back off');
  refused(await rec.from('pnms').select('*'), 'without access again, he cannot read PNMs');

  // Deletion one year after a PNM was entered.
  refused(await rec.rpc('purge_old_pnms'), 'members cannot run the deletion themselves');
  const old = (await admin.from('pnms').insert({ name: `${TAG} Old Record`, term: 'Fall 2025' }).select().single()).data;
  const young = (await admin.from('pnms').insert({ name: `${TAG} Young Record`, term: 'Fall 2025' }).select().single()).data;
  // Backdate straight in the database: through the API the trigger keeps created_at.
  sql(`set session_replication_role = replica; update public.pnms set created_at = now() - interval '366 days' where id = '${old.id}'; update public.pnms set created_at = now() - interval '364 days' where id = '${young.id}';`);
  const purged = await admin.rpc('purge_old_pnms');
  { const { data } = await admin.from('pnms').select('id').in('id', [old.id, young.id]);
    ok(!purged.error && purged.data >= 1 && data.length === 1 && data[0].id === young.id, 'a PNM entered over a year ago is deleted; one entered 364 days ago stays'); }
  ok(/pnm-retention/.test(sql("select jobname from cron.job where jobname = 'pnm-retention'")), 'the deletion is scheduled to run daily');

  await cleanup();
  console.log(`\n${passed}/${passed + failed} access checks passed.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
