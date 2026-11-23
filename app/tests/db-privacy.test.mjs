// Run: npm run test:db
// Applies supabase/migrations/*.sql to an in-memory Postgres (PGlite) with minimal stand-ins
// for Supabase's auth/storage schemas, then checks the privacy rules as real users.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.argv[2] ?? new URL('../..', import.meta.url).pathname;
const db = new PGlite();
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated;
  grant all on all tables in schema storage to authenticated;
  -- Like a new Supabase project: no automatic table access. The migrations must grant it.
`);

const dir = join(repo, 'supabase', 'migrations');
for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(dir, f), 'utf8'));
  console.log(`applied ${f}`);
}

const users = {
  alice: { id: '00000000-0000-0000-0000-00000000000a', email: 'alice@acme.test', name: 'Alice Owner' },
  bob:   { id: '00000000-0000-0000-0000-00000000000b', email: 'bob@acme.test',   name: 'Bob Member' },
  carol: { id: '00000000-0000-0000-0000-00000000000c', email: 'carol@acme.test', name: 'Carol Manager' },
  dave:  { id: '00000000-0000-0000-0000-00000000000d', email: 'dave@other.test', name: 'Dave Outsider' },
};
for (const u of Object.values(users)) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [u.id, u.email, { full_name: u.name }]);
}

async function as(user, sql, params = []) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
    [user.id, JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
async function fails(user, sql, params = []) { try { await as(user, sql, params); return false; } catch { return true; } }

const p = await db.query(`select count(*)::int n from public.profiles`);
ok(p.rows[0].n === 4, 'profile created automatically for each new user');

const team = (await as(users.alice, `select public.create_team('Acme Mechanical') id`)).rows[0].id;
ok(!!team, 'alice creates a team');
ok((await as(users.alice, `select role from public.team_members where team_id=$1`, [team])).rows[0]?.role === 'owner', 'creator becomes owner');
ok(await fails(users.alice, `insert into public.teams (name) values ('Sneaky')`), 'teams cannot be inserted directly (only via create_team)');

await as(users.alice, `insert into public.team_invites (team_id, email, role) values ($1, 'bob@acme.test', 'member'), ($1, 'carol@acme.test', 'manager')`, [team]);
ok((await as(users.bob, `select * from public.my_invites()`)).rows.length === 1, 'bob sees his pending invite');
ok((await as(users.dave, `select * from public.my_invites()`)).rows.length === 0, 'dave sees no invites');
ok(await fails(users.dave, `select public.accept_invite(id) from public.team_invites`) ||
   (await as(users.dave, `select count(*)::int n from public.team_invites`)).rows[0].n === 0, 'dave cannot see or accept others\' invites');
for (const u of [users.bob, users.carol]) {
  const inv = (await as(u, `select id from public.my_invites()`)).rows[0].id;
  await as(u, `select public.accept_invite($1)`, [inv]);
}
const roster = (await as(users.bob, `select user_id, role from public.team_members where team_id=$1 order by role`, [team])).rows;
ok(roster.length === 3, 'bob and carol joined; roster visible to members');
ok(await fails(users.bob, `insert into public.team_invites (team_id, email) values ($1, 'x@acme.test')`, [team]), 'members cannot invite');
ok(!(await fails(users.carol, `insert into public.team_invites (team_id, email, role) values ($1, 'y@acme.test', 'member')`, [team])), 'managers can invite members');
ok(await fails(users.carol, `insert into public.team_invites (team_id, email, role) values ($1, 'z@acme.test', 'manager')`, [team]), 'managers cannot invite managers');

await as(users.alice, `insert into public.contacts (full_name, team_id, visibility) values
  ('Personal private', null, 'private'),
  ('Team private', $1, 'private'),
  ('Team managers', $1, 'managers'),
  ('Team shared', $1, 'team')`, [team]);
const seen = async u => (await as(u, `select full_name from public.contacts order by full_name`)).rows.map(r => r.full_name);
ok(JSON.stringify(await seen(users.alice)) === JSON.stringify(['Personal private', 'Team managers', 'Team private', 'Team shared']), 'author sees all four of her contacts');
ok(JSON.stringify(await seen(users.bob)) === JSON.stringify(['Team shared']), 'member sees only team-visible record');
ok(JSON.stringify(await seen(users.carol)) === JSON.stringify(['Team managers', 'Team shared']), 'manager sees team + managers records, never private ones');
ok((await seen(users.dave)).length === 0, 'outsider sees nothing');
ok(await fails(users.dave, `insert into public.contacts (full_name, team_id, visibility) values ('x', $1, 'team')`, [team]), 'outsider cannot write into the team');
ok(await fails(users.alice, `insert into public.contacts (owner_id, full_name) values ($1, 'Forged')`, [users.bob.id]), 'cannot create records as someone else');
const upd = await as(users.bob, `update public.contacts set full_name = 'hacked' where full_name = 'Team shared' returning id`);
ok(upd.rows.length === 0, 'member cannot edit another person\'s record');

const contactId = (await as(users.alice, `select id from public.contacts where full_name='Team shared'`)).rows[0].id;
await as(users.alice, `insert into public.contact_identities (contact_id, kind, value) values ($1, 'email', 'cust@client.test')`, [contactId]);
ok((await as(users.bob, `select count(*)::int n from public.contact_identities`)).rows[0].n === 1, 'identities follow their contact\'s visibility');
ok(await fails(users.bob, `insert into public.contact_identities (contact_id, kind, value) values ($1, 'email', 'evil@x.test')`, [contactId]), 'only the contact\'s author can add identities');

// Background sync reads each user's contacts with nobody signed in: same rules as a signed-in read.
async function asServer(sql, params = []) {
  await db.exec('reset role'); await db.exec("select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false)");
  await db.exec('set role service_role');
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const syncSees = async u => (await asServer(`select s.contact_id, s.identities, c.full_name from public.sync_contacts_for($1) s join public.contacts c on c.id = s.contact_id order by c.full_name`, [u.id])).rows;
ok((await syncSees(users.alice)).length === 4, 'background sync reads all of alice\'s contacts for alice');
const bobSync = await syncSees(users.bob);
ok(bobSync.length === 1 && bobSync[0].full_name === 'Team shared' && bobSync[0].identities.length === 1 && bobSync[0].identities[0].value === 'cust@client.test',
   'background sync for bob sees only team-visible contacts, with their addresses');
ok(JSON.stringify((await syncSees(users.carol)).map(r => r.full_name)) === JSON.stringify(['Team managers', 'Team shared']), 'background sync for a manager follows manager visibility');
ok((await syncSees(users.dave)).length === 0, 'background sync for an outsider sees nothing');
ok(await fails(users.bob, `select * from public.sync_contacts_for($1)`, [users.alice.id]), 'users cannot call the background-sync contact reader');
ok(await fails(users.bob, `select * from public.integration_secrets`), 'browser roles cannot read OAuth tokens');
ok(await fails(users.bob, `insert into public.integration_connections (provider) values ('google')`), 'connections are written by the server only');

ok(await fails(users.alice, `insert into public.meetings (kind, consent_confirmed) values ('meeting', false)`), 'a recorded meeting requires consent confirmation');
ok(!(await fails(users.alice, `insert into public.meetings (kind, consent_confirmed) values ('notes', false)`)), 'voice notes do not need participant consent');

ok(!(await fails(users.alice, `insert into storage.objects (bucket_id, name) values ('recordings', $1)`, [users.alice.id + '/m1.webm'])), 'user uploads into her own recordings folder');
ok(await fails(users.bob, `insert into storage.objects (bucket_id, name) values ('recordings', $1)`, [users.alice.id + '/m2.webm']), 'user cannot upload into someone else\'s folder');
ok((await as(users.bob, `select count(*)::int n from storage.objects`)).rows[0].n === 0, 'user cannot see someone else\'s recordings');

ok((await as(users.bob, `select count(*)::int n from public.profiles`)).rows[0].n === 3, 'teammates can see each other\'s profiles (not outsiders)');
ok(await fails(users.alice, `delete from public.team_members where user_id = $1 and team_id = $2 returning 1`, [users.alice.id, team]) ||
   (await as(users.alice, `select count(*)::int n from public.team_members where user_id=$1`, [users.alice.id])).rows[0].n === 1, 'the owner cannot leave her own team');
await as(users.bob, `delete from public.team_members where user_id = $1 and team_id = $2`, [users.bob.id, team]);
ok((await seen(users.bob)).length === 0, 'after leaving, bob loses access to team records immediately');

// ---- Meeting capture: finalize_meeting() files a reviewed meeting atomically ----
const ids = Object.fromEntries((await as(users.alice, `select full_name, id from public.contacts`)).rows.map(r => [r.full_name, r.id]));
const meeting = (await as(users.alice, `insert into public.meetings (kind, consent_confirmed, title, duration_sec) values ('meeting', true, 'Riverside check-in', 900) returning id`)).rows[0].id;
const outsiderContact = (await as(users.dave, `insert into public.contacts (full_name) values ('Dave private') returning id`)).rows[0].id;
const promisesJson = JSON.stringify([
  { title: 'Send revised drawings', direction: 'made_by_me', due_on: '2026-12-04', contact_id: ids['Team shared'], evidence: 'I will send them Friday' },
  { title: 'Approve alternate', direction: 'made_to_me', due_on: '', contact_id: outsiderContact, evidence: 'They will approve' },
  { title: '   ', direction: 'made_by_me' },
]);
const finalize = (u, mid) => as(u, `select public.finalize_meeting($1, 'Riverside check-in', $2, 'transcript', $3::uuid[], null, $4, 'team', $5::jsonb) id`,
  [mid, 'Summary\nReviewed drawings and schedule.\n\nAction items\n• Send drawings', `{${ids['Team shared']},${outsiderContact}}`, team, promisesJson]);
ok(!!(await finalize(users.alice, meeting)).rows[0].id, 'author files a reviewed meeting');
const linked = (await as(users.alice, `select contact_id from public.meeting_contacts where meeting_id=$1`, [meeting])).rows;
ok(linked.length === 1 && linked[0].contact_id === ids['Team shared'], 'only contacts the author can see get linked (outsider contact dropped)');
const prs = (await as(users.alice, `select title, contact_id, due_on, direction from public.promises where source_ref=$1 order by title`, [meeting])).rows;
ok(prs.length === 2, 'blank promises are skipped; approved promises are created');
ok(prs.every(p => p.contact_id === ids['Team shared']), 'a promise naming an unreadable contact falls back to a linked contact');
ok((await as(users.alice, `select summary from public.interactions where source_ref=$1`, [meeting + ':' + ids['Team shared']])).rows[0]?.summary === 'Reviewed drawings and schedule.', 'timeline entry uses the first line of the summary');
ok((await as(users.alice, `select last_engagement_at from public.contacts where id=$1`, [ids['Team shared']])).rows[0].last_engagement_at !== null, 'a recorded meeting updates last engagement');
await finalize(users.alice, meeting);
ok((await as(users.alice, `select count(*)::int n from public.interactions where source='recording'`)).rows[0].n === 1 &&
   (await as(users.alice, `select count(*)::int n from public.promises where source_ref=$1`, [meeting])).rows[0].n === 2, 're-filing does not duplicate timeline entries or promises');
ok((await as(users.carol, `select count(*)::int n from public.meetings where id=$1`, [meeting])).rows[0].n === 1, 'team-shared meeting is visible to the manager');
ok((await as(users.carol, `select count(*)::int n from public.promises where source_ref=$1`, [meeting])).rows[0].n === 2, 'its promises are visible to the team');
ok(await fails(users.carol, `select public.finalize_meeting($1, 'x', 'x', null, '{}', null, null, 'private', '[]')`, [meeting]), 'nobody else can file or rewrite your meeting');
ok((await as(users.dave, `select count(*)::int n from public.meetings`)).rows[0].n === 0, 'outsiders cannot see the meeting');
const priv = (await as(users.alice, `insert into public.meetings (kind, title) values ('notes', 'Private voice note') returning id`)).rows[0].id;
await as(users.alice, `select public.finalize_meeting($1, 'Private voice note', 'secret', null, '{}', null, null, 'team', '[]')`, [priv]);
ok((await as(users.alice, `select visibility from public.meetings where id=$1`, [priv])).rows[0].visibility === 'private', 'personal-workspace notes are always private');
ok((await as(users.carol, `select count(*)::int n from public.meetings where id=$1`, [priv])).rows[0].n === 0, 'managers never see personal notes');

// Phase 3: Google Calendar and Gmail. Rows are written by the sync function (service role).
async function asService(sql, params = []) {
  await db.exec('reset role'); await db.exec('set role service_role');
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const conn = (await asService(`insert into public.integration_connections (user_id, provider, account_email) values ($1, 'google', $2) returning id`, [users.alice.id, users.alice.email])).rows[0].id;
await asService(`insert into public.integration_secrets (connection_id, refresh_token) values ($1, 'v1:encrypted')`, [conn]);
await asService(`insert into public.calendar_events (owner_id, connection_id, source_ref, title, starts_at) values ($1, $2, 'evt1', 'Riverside walkthrough', now() + interval '1 day')`, [users.alice.id, conn]);
const thread = (await asService(`insert into public.email_threads (owner_id, connection_id, thread_id, subject, last_message_at, last_direction, needs_reply) values ($1, $2, 't1', 'Revised drawings', now(), 'inbound', true) returning id`, [users.alice.id, conn])).rows[0].id;
await asService(`insert into public.oauth_states (nonce, user_id, provider) values ('n1', $1, 'google')`, [users.alice.id]);
ok((await as(users.alice, `select account_email from public.integration_connections`)).rows.length === 1, 'you can see your own connected Google account');
ok((await as(users.carol, `select count(*)::int n from public.integration_connections`)).rows[0].n === 0, 'teammates cannot see your connected accounts');
ok(await fails(users.alice, `select refresh_token from public.integration_secrets`), 'Google tokens are unreadable even by their owner (server only)');
ok(await fails(users.alice, `select * from public.oauth_states`), 'sign-in state values are server only');
ok(await fails(users.alice, `insert into public.integration_connections (user_id, provider) values ($1, 'google')`, [users.alice.id]), 'only the server can add a connection');
ok((await as(users.alice, `select count(*)::int n from public.calendar_events`)).rows[0].n === 1, 'you see your own calendar events');
ok((await as(users.carol, `select count(*)::int n from public.calendar_events`)).rows[0].n === 0, 'your manager cannot see your calendar');
ok((await as(users.carol, `select count(*)::int n from public.email_threads`)).rows[0].n === 0, 'your manager cannot see your email');
ok(await fails(users.alice, `insert into public.calendar_events (owner_id, connection_id, source_ref, starts_at) values ($1, $2, 'x', now())`, [users.alice.id, conn]), 'calendar events cannot be forged from the browser');
await as(users.alice, `update public.email_threads set dismissed_at = now() where id = $1`, [thread]);
ok((await as(users.alice, `select dismissed_at from public.email_threads where id=$1`, [thread])).rows[0].dismissed_at !== null, 'you can mark an email as not needing a reply');
ok(await fails(users.alice, `update public.email_threads set subject = 'x' where id = $1`, [thread]), 'synced email content cannot be edited');
await as(users.carol, `update public.email_threads set dismissed_at = null where id = $1`, [thread]);
ok((await as(users.alice, `select dismissed_at from public.email_threads where id=$1`, [thread])).rows[0].dismissed_at !== null, 'others cannot change your email threads');
const sugg = (await asService(`insert into public.promises (owner_id, title, status, source, source_ref) values ($1, 'Send revised drawings', 'suggested', 'gmail', 'm1') returning id`, [users.alice.id])).rows[0].id;
ok(await asService(`insert into public.promises (owner_id, title, status, source, source_ref) values ($1, 'Send revised drawings', 'suggested', 'gmail', 'm1')`, [users.alice.id]).then(() => false, () => true), 'the same email promise is never suggested twice');
await asService(`insert into public.promises (owner_id, title, status, source, source_ref) values ($1, 'Send revised drawings', 'suggested', 'outlook', 'o1')`, [users.alice.id]);
ok(await asService(`insert into public.promises (owner_id, title, status, source, source_ref) values ($1, 'Send revised drawings', 'suggested', 'outlook', 'o1')`, [users.alice.id]).then(() => false, () => true), 'the same Outlook promise is never suggested twice');
const msConn = (await asService(`insert into public.integration_connections (user_id, provider, account_email, scopes) values ($1, 'microsoft', $2, '{Mail.Read,Calendars.Read}') returning id`, [users.alice.id, 'alice@contoso.test'])).rows[0].id;
await asService(`insert into public.calendar_events (owner_id, connection_id, source_ref, title, starts_at) values ($1, $2, 'AAMk1', 'Outlook meeting', now() + interval '1 day')`, [users.alice.id, msConn]);
ok((await as(users.alice, `select count(*)::int n from public.integration_connections where provider='microsoft'`)).rows[0].n === 1, 'a Microsoft account connects alongside Google');
ok((await as(users.carol, `select count(*)::int n from public.calendar_events`)).rows[0].n === 0, 'your manager cannot see your Outlook calendar');
await as(users.alice, `delete from public.integration_connections where id = $1`, [msConn]);
ok((await asService(`select count(*)::int n from public.calendar_events where connection_id = $1`, [msConn])).rows[0].n === 0, 'disconnecting Microsoft deletes its synced events');
await as(users.alice, `update public.promises set status = 'open' where id = $1`, [sugg]);
ok((await as(users.alice, `select status from public.promises where id=$1`, [sugg])).rows[0].status === 'open', 'you can keep a suggested promise');
const ms = (await asService(`insert into public.meeting_suggestions (owner_id, connection_id, source_ref, title, starts_at, contact_ids) values ($1, $2, 'm9', 'Site walk with Sarah', now() + interval '2 days', '{}') returning id`, [users.alice.id, conn])).rows[0].id;
ok((await as(users.alice, `select count(*)::int n from public.meeting_suggestions`)).rows[0].n === 1, 'you see meetings suggested from your email');
ok((await as(users.carol, `select count(*)::int n from public.meeting_suggestions`)).rows[0].n === 0, 'your manager cannot see meetings suggested from your email');
ok(await fails(users.alice, `update public.meeting_suggestions set starts_at = now() where id = $1`, [ms]), 'suggested meeting details can only change through the server');
await as(users.alice, `update public.meeting_suggestions set status = 'dismissed' where id = $1`, [ms]);
ok((await as(users.alice, `select status from public.meeting_suggestions where id=$1`, [ms])).rows[0].status === 'dismissed', 'you can dismiss a suggested meeting');
ok(await fails(users.alice, `update public.meeting_suggestions set status = 'bogus' where id = $1`, [ms]), 'only valid statuses are accepted');
await as(users.alice, `delete from public.integration_connections where id = $1`, [conn]);
ok((await asService(`select count(*)::int n from public.meeting_suggestions`)).rows[0].n === 0, 'disconnecting deletes meeting suggestions too');
ok((await asService(`select (select count(*) from public.calendar_events)::int + (select count(*) from public.email_threads)::int + (select count(*) from public.integration_secrets)::int n`)).rows[0].n === 0, 'disconnecting deletes the tokens, events and email threads');

// Signed-out visitors (anon) get nothing.
async function asAnon(sql) {
  await db.exec('reset role'); await db.exec("select set_config('request.jwt.claim.sub', '', false)"); await db.exec('set role anon');
  try { return await db.query(sql); } finally { await db.exec('reset role'); }
}
let anonBlocked = true;
for (const t of ['profiles', 'teams', 'contacts', 'team_invites', 'integration_secrets', 'calendar_events', 'email_threads', 'oauth_states', 'meeting_suggestions']) {
  try { await asAnon(`select * from public.${t}`); anonBlocked = false; } catch {}
}
ok(anonBlocked, 'signed-out visitors cannot read any table');
let rpcBlocked = true; try { await asAnon('select * from public.my_invites()'); rpcBlocked = false; } catch {}
try { await asAnon(`select * from public.sync_contacts_for('00000000-0000-0000-0000-00000000000a')`); rpcBlocked = false; } catch {}
ok(rpcBlocked, 'signed-out visitors cannot call account functions');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll privacy checks passed');
process.exit(failures ? 1 : 0);
