// End-to-end tests of the Worker against an in-memory database. Synthetic identities only.
import test from 'node:test';
import { awsSign, ses, bulkSafe } from '../src/worker/ses.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, sign as rsaSign } from 'node:crypto';
import { stringToSign, _clearCertCache } from '../src/worker/sns.mjs';
import assert from 'node:assert/strict';
import { makeEnv, client, tickAll } from './helpers.mjs';
import { build } from '../src/build.mjs';
import { tick } from '../src/worker/sending.mjs';
import { buildMime, providerChain, brevo, resend } from '../src/worker/providers.mjs';

await build({ SITE_URL: 'https://preview.example', SITE_ENV: 'preview' });
const one = (env, sql, ...a) => env.DB.sqlite.prepare(sql).get(...a);
const many = (env, sql, ...a) => env.DB.sqlite.prepare(sql).all(...a).map((r) => ({ ...r }));
const signup = (c, email, extra = {}) => c.post('/api/subscribe', { email, elapsed_ms: 5000, ...extra });
const SLUG = 'week-of-november-1-8-2026';

test('signup with attribution, double opt-in confirmation, and unsubscribe', async () => {
  const env = await makeEnv(), c = client(env);
  const r = await signup(c, ' Ada.Reader@Example.com ', { utm_source: 'founders', utm_medium: 'partner', utm_campaign: 'founders_2026', referrer: 'https://www.linkedin.com/feed/', landing_path: '/s/founders/', form: 'subscribe-page' });
  assert.equal(r.status, 200);
  let p = one(env, 'SELECT * FROM people');
  assert.equal(p.email_norm, 'ada.reader@example.com');
  assert.equal(p.status, 'pending');
  assert.deepEqual([p.utm_source, p.utm_medium, p.utm_campaign, p.signup_form, p.source], ['founders', 'partner', 'founders_2026', 'subscribe-page', 'website: founders / partner']);
  assert.equal(one(env, "SELECT COUNT(*) n FROM delivery_events WHERE type = 'confirmation_sent' AND provider = 'dryrun'").n, 1);
  // GET shows a button and does not confirm (mail scanners pre-fetch links)
  assert.equal((await c.get(r.data.dev_confirm_url)).status, 200);
  assert.equal(one(env, 'SELECT status FROM people').status, 'pending');
  assert.equal((await c.post(r.data.dev_confirm_url)).status, 303);
  p = one(env, 'SELECT * FROM people');
  assert.deepEqual([p.status, p.email_verification], ['active', 'verified']);
  assert.ok(p.confirmed_at && p.subscribed_at);
  // signing up again reveals nothing and changes nothing
  const again = await signup(c, 'ada.reader@example.com');
  assert.equal(again.data.message, r.data.message);
  assert.equal(one(env, 'SELECT COUNT(*) n FROM people').n, 1);
  // one-click unsubscribe (POST) suppresses the address
  assert.equal((await c.post(`/u/${p.token}`)).status, 303);
  assert.equal(one(env, 'SELECT status FROM people').status, 'unsubscribed');
  assert.equal(one(env, 'SELECT reason FROM suppressions WHERE email_norm = ?', 'ada.reader@example.com').reason, 'unsubscribed');
  assert.deepEqual(many(env, 'SELECT to_status FROM status_history ORDER BY id').map((h) => h.to_status), ['pending', 'active', 'unsubscribed']);
  // a returning reader must confirm by email again; the form alone never re-activates
  await signup(c, 'ada.reader@example.com');
  assert.equal(one(env, 'SELECT status FROM people').status, 'unsubscribed');
  await c.post(`/confirm/${p.token}`);
  assert.equal(one(env, 'SELECT status FROM people').status, 'active');
  assert.equal(one(env, 'SELECT COUNT(*) n FROM suppressions').n, 0);
});

test('signup abuse controls: honeypot, speed trap, bad addresses, rate limits', async () => {
  const env = await makeEnv({ SIGNUP_LIMIT_PER_HOUR: '3' }), c = client(env);
  assert.equal((await c.post('/api/subscribe', { email: 'bot@example.com', website: 'http://spam', elapsed_ms: 9000 })).status, 200);
  assert.equal((await c.post('/api/subscribe', { email: 'fast@example.com', elapsed_ms: 100 })).status, 200);
  assert.equal(one(env, 'SELECT COUNT(*) n FROM people').n, 0, 'bots get a success message but nothing is stored');
  assert.equal((await signup(c, 'not-an-email')).status, 400);
  for (const e of ['a@example.com', 'b@example.com']) assert.equal((await signup(c, e)).status, 200);
  assert.equal((await signup(c, 'c@example.com')).status, 429);
  // confirmation mails per address are capped
  const env2 = await makeEnv({ SIGNUP_LIMIT_PER_HOUR: '50' }), c2 = client(env2);
  for (let i = 0; i < 6; i++) await signup(c2, 'target@example.com');
  assert.equal(one(env2, "SELECT COUNT(*) n FROM delivery_events WHERE type = 'confirmation_sent'").n, 3);
});

test('admin API requires a valid session; private data is never public', async () => {
  const env = await makeEnv(), c = client(env);
  await signup(c, 'private@example.com');
  for (const u of ['/api/admin/people', '/api/admin/export/people.csv', '/api/admin/export/backup.json', '/api/admin/dashboard', '/api/admin/audit', '/api/admin/people/1'])
    assert.equal((await c.get(u)).status, 401, u);
  assert.equal((await c.post('/api/admin/imports/commit', { csv: 'email\nx@example.com' })).status, 401);
  assert.equal((await c.post('/api/admin/login', { password: 'wrong' })).status, 401);
  assert.equal((await c.get('/api/admin/people', { cookie: 'prompted_admin=owner.9999999999999.deadbeef' })).status, 401, 'forged cookie');
  assert.equal((await c.login()).status, 200);
  const list = await c.get('/api/admin/people');
  assert.equal(list.data.total, 1);
  assert.ok(!('token' in list.data.rows[0]), 'link tokens never leave the server');
  assert.equal((await c.post('/api/admin/people/bulk', { ids: [1], action: 'tag', value: 'x' }, { origin: 'https://evil.example' })).status, 403, 'cross-site write blocked');
  // login throttling
  const env2 = await makeEnv(), c2 = client(env2);
  let last;
  for (let i = 0; i < 10; i++) last = await c2.post('/api/admin/login', { password: 'nope' });
  assert.equal(last.status, 429);
  // static site never contains the address
  const home = await c.get('/');
  assert.ok(!String(home.data).includes('private@example.com'));
  assert.equal(home.headers.get('x-robots-tag'), 'noindex, nofollow');
});

const ROSTER = `Email,First Name,Last Name,Organizations,Role,Miami Unique ID,AWE Member LOA,Email Verification
newone@example.edu,New,One,Founders,Member,newone,,inferred
loa.person@example.edu,Loa,Person,AWE,Member,loaperson,Member LOA,inferred
existing@example.edu,Exi,Sting,Founders; SEPi,President; Member,existing,,verified
gone@example.edu,Gone,Reader,SEPi,Member,gone,,inferred
typo@example.edu,Jack,Typo,Founders,Member,jtypo,,inferred
NEWONE@example.edu,Dup,Row,Founders,Member,newone,,inferred
not-an-email,Bad,Row,Founders,Member,bad,,
`;

test('CSV import: preview, dedupe, suppression protection, LOA kept, idempotent, consent gate', async () => {
  const env = await makeEnv(), c = client(env);
  await c.login();
  // existing audience migrated from the old system: one active, one unsubscribed, one corrected typo address
  const ledger = 'email,status,subscribed_at,unsubscribed_at,acquisition_source,tags\nexisting@example.edu,active,2026-08-27T00:21:51Z,,import: direct / (none),legacy_prompted\ngone@example.edu,inactive,2026-09-01T16:45:25Z,2026-09-08T13:28:06Z,import: faculty / (none),\ntypo@example.edu,inactive,2026-08-27T00:21:51Z,2026-11-10T21:35:41Z,import: direct / (none),legacy_prompted\npending@example.edu,pending,2026-10-06T10:10:14Z,,website: drew / sponsorship,\n';
  const mig = await c.post('/api/admin/imports/commit', { csv: ledger, mode: 'migration', source_label: 'beehiiv ledger', filename: 'ledger.csv' });
  assert.deepEqual([mig.data.totals.new, mig.data.totals.rows], [4, 4]);
  assert.deepEqual(many(env, 'SELECT email_norm, status, subscribed_at, unsubscribed_at FROM people ORDER BY id').map((p) => [p.email_norm, p.status]),
    [['existing@example.edu', 'active'], ['gone@example.edu', 'unsubscribed'], ['typo@example.edu', 'unsubscribed'], ['pending@example.edu', 'pending']]);
  assert.equal(one(env, "SELECT subscribed_at FROM people WHERE email_norm = 'existing@example.edu'").subscribed_at, '2026-08-27T00:21:51.000Z', 'original dates preserved');
  assert.equal(one(env, 'SELECT COUNT(*) n FROM suppressions').n, 2);

  const pre = await c.post('/api/admin/imports/preview', { csv: ROSTER, source_label: 'roster: Founders/AWE/SEPi', target_status: 'prospective' });
  assert.deepEqual(pre.data.totals, { rows: 7, new: 2, existing: 1, suppressed: 2, duplicate_in_file: 1, rejected: 1 });
  assert.equal(pre.data.mapping['Miami Unique ID'], 'institution_id');
  assert.equal(one(env, 'SELECT COUNT(*) n FROM people').n, 4, 'preview writes nothing');

  // activating by import needs the owner's explicit attestation
  assert.equal((await c.post('/api/admin/imports/commit', { csv: ROSTER, source_label: 'roster', target_status: 'active' })).status, 400);
  const done = await c.post('/api/admin/imports/commit', { csv: ROSTER, source_label: 'roster: Founders/AWE/SEPi', target_status: 'prospective', filename: 'roster.csv' });
  assert.equal(done.data.already_imported, false);
  const by = (e) => one(env, 'SELECT * FROM people WHERE email_norm = ?', e);
  assert.deepEqual([by('newone@example.edu').status, by('newone@example.edu').institution_id, by('newone@example.edu').email_verification], ['prospective', 'newone', 'inferred']);
  assert.deepEqual([by('loa.person@example.edu').status, by('loa.person@example.edu').member_loa], ['prospective', 1], 'LOA is a flag, not a verdict');
  assert.equal(by('existing@example.edu').status, 'active', 'existing subscriber untouched');
  assert.equal(by('gone@example.edu').status, 'unsubscribed', 'unsubscribed reader not re-enabled');
  assert.equal(by('typo@example.edu').status, 'unsubscribed', 'retired typo address not re-activated');
  assert.equal(one(env, 'SELECT COUNT(*) n FROM people').n, 6, 'no duplicates created');
  assert.deepEqual(many(env, "SELECT o.name, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id JOIN people p ON p.id = m.person_id WHERE p.email_norm = 'existing@example.edu' ORDER BY o.name"),
    [{ name: 'Founders', role: 'President' }, { name: 'SEPi', role: 'Member' }]);
  // idempotent re-run
  const again = await c.post('/api/admin/imports/commit', { csv: ROSTER, source_label: 'roster: Founders/AWE/SEPi', target_status: 'prospective' });
  assert.equal(again.data.already_imported, true);
  assert.equal(one(env, 'SELECT COUNT(*) n FROM people').n, 6);
  const report = await c.get(`/api/admin/imports/${done.data.batch_id}`);
  assert.equal(report.data.rows.length, 7);
  // export: filtered CSV and a full backup that restores into an empty database
  const csv = await c.get('/api/admin/export/people.csv?status=prospective');
  assert.equal(String(csv.data).trim().split('\r\n').length, 3);
  const backup = await c.get('/api/admin/export/backup.json');
  assert.equal(backup.data.tables.people.length, 6);
  const env2 = await makeEnv(), c2 = client(env2);
  await c2.login();
  assert.ok((await c2.post('/api/admin/restore', backup.data)).data.restored_rows > 20);
  assert.deepEqual(many(env2, 'SELECT email_norm, status FROM people ORDER BY id'), many(env, 'SELECT email_norm, status FROM people ORDER BY id'));
  assert.equal(one(env2, 'SELECT COUNT(*) n FROM suppressions').n, 2);
  assert.equal((await c2.post('/api/admin/restore', backup.data)).status, 409, 'restore never merges over live data');
});

test('CRM edits: manual add needs consent, suppressed addresses blocked, notes and audit trail', async () => {
  const env = await makeEnv(), c = client(env);
  await c.login();
  assert.equal((await c.post('/api/admin/people', { email: 'm@example.com', status: 'active' })).status, 400);
  const p = await c.post('/api/admin/people', { email: 'm@example.com', first_name: 'Mo', status: 'active', consent_attested: true });
  assert.equal(p.status, 201);
  await c.patch('/api/admin/people/1', { last_name: 'Lee', tags: ['vip'], memberships: [{ org: 'RedHawk Ventures', role: 'Analyst' }], notes: 'met at demo day' });
  await c.post('/api/admin/people/1/interactions', { kind: 'email', body: 'Replied about sponsorship' });
  const full = (await c.get('/api/admin/people/1')).data;
  assert.deepEqual([full.last_name, full.tags, full.memberships[0].org, full.interactions.length], ['Lee', ['vip'], 'RedHawk Ventures', 1]);
  await c.post('/api/admin/suppressions', { email: 'blocked@example.com', reason: 'manual', detail: 'asked not to be contacted' });
  assert.equal((await c.post('/api/admin/people', { email: 'blocked@example.com' })).status, 409);
  await signup(c, 'blocked@example.com');
  assert.equal(one(env, "SELECT COUNT(*) n FROM people WHERE email_norm = 'blocked@example.com'").n, 0, 'manual suppression also blocks public signup');
  await c.post('/api/admin/people/1/status', { status: 'unsubscribed', reason: 'asked by email' });
  assert.equal((await c.post('/api/admin/people/1/status', { status: 'active' })).status, 400, 're-activation needs attestation');
  const actions = many(env, 'SELECT action FROM audit_log').map((a) => a.action);
  for (const a of ['login.ok', 'person.create', 'person.update', 'suppression.add', 'person.status']) assert.ok(actions.includes(a), a);
});

async function audience(env, n, extra = []) {
  const rows = ['email,status', ...Array.from({ length: n }, (_, i) => `reader${i}@example.com,active`), ...extra].join('\n');
  const c = client(env);
  await c.login();
  await c.post('/api/admin/imports/commit', { csv: rows, mode: 'migration', source_label: 'synthetic' });
  return c;
}

test('publishing pipeline: QA gate, owner approval, schedule, send once, no duplicates, suppression respected', async () => {
  const env = await makeEnv({ SEND_CHUNK: '25' });
  const c = await audience(env, 60, ['left@example.com,inactive', 'bounced@example.com,bounced', 'prospect@example.com,prospective']);
  const send = await c.post('/api/admin/sends', { issue_slug: SLUG });
  assert.equal(send.status, 201);
  assert.deepEqual([send.data.status, send.data.qa.ok], ['draft', true]);
  assert.equal((await c.post('/api/admin/sends', { issue_slug: SLUG })).status, 409, 'an issue can only have one live send');
  assert.equal((await c.post(`/api/admin/sends/${send.data.id}/schedule`, {})).status, 409, 'cannot schedule before owner approval');
  assert.equal((await c.post(`/api/admin/sends/${send.data.id}/approve`)).data.status, 'approved');
  const sch = await c.post(`/api/admin/sends/${send.data.id}/schedule`, {});
  assert.equal(sch.data.status, 'scheduled');
  assert.equal(new Date(sch.data.scheduled_at).getUTCDay(), 1, 'defaults to a Monday');
  assert.ok(['12:45', '13:45'].includes(sch.data.scheduled_at.slice(11, 16)), '8:45 a.m. Eastern');
  assert.deepEqual(await tick(env), [], 'nothing is sent before the scheduled time');
  assert.equal(one(env, 'SELECT COUNT(*) n FROM send_recipients').n, 0);
  env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(send.data.id);
  const ticks = await tickAll(env);
  assert.ok(ticks >= 3, 'sent in chunks');
  const final = (await c.get(`/api/admin/sends/${send.data.id}`)).data;
  assert.deepEqual([final.status, final.recipients.sent], ['sent', 60]);
  const sentTo = many(env, 'SELECT email_norm FROM send_recipients').map((r) => r.email_norm);
  for (const e of ['left@example.com', 'bounced@example.com', 'prospect@example.com']) assert.ok(!sentTo.includes(e), `${e} must not be mailed`);
  assert.equal(new Set(sentTo).size, 60);
  await tickAll(env);
  assert.equal(one(env, "SELECT COUNT(*) n FROM delivery_events WHERE type = 'sent'").n, 60, 'further cron runs send nothing more');
  assert.equal((await c.post('/api/admin/sends', { issue_slug: SLUG })).status, 409, 'a sent issue cannot be sent again');
  assert.equal((await c.post(`/api/admin/sends/${send.data.id}/cancel`)).status, 409);
  // open + click tracking and the dashboard
  const r = one(env, 'SELECT track_id FROM send_recipients LIMIT 1');
  assert.equal((await c.get(`/o/${r.track_id}.gif`)).headers.get('content-type'), 'image/gif');
  const dash = (await c.get('/api/admin/dashboard')).data;
  assert.equal(dash.audience.active, 60);
  const row = dash.issues.find((i) => i.slug === SLUG);
  assert.deepEqual([row.platform.recipients, row.platform.unique_opens], [60, 1]);
  assert.equal(dash.send_mode, 'dryrun');
});

test('free-tier quota: a send larger than the daily cap pauses and resumes, never over-sends', async () => {
  const env = await makeEnv({ SEND_CHUNK: '50', DRYRUN_DAILY_LIMIT: '70', QUOTA_RESERVE: '10' });
  const c = await audience(env, 100);
  const send = await c.post('/api/admin/sends', { issue_slug: SLUG });
  await c.post(`/api/admin/sends/${send.data.id}/approve`);
  await c.post(`/api/admin/sends/${send.data.id}/schedule`, {});
  env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
  for (let i = 0; i < 6; i++) await tick(env);
  let s = (await c.get(`/api/admin/sends/${send.data.id}`)).data;
  assert.deepEqual([s.status, s.recipients.sent, s.recipients.queued], ['sending', 60, 40], 'stops at cap minus reserve');
  env.DB.sqlite.prepare('DELETE FROM provider_usage').run(); // next day
  await tickAll(env);
  s = (await c.get(`/api/admin/sends/${send.data.id}`)).data;
  assert.deepEqual([s.status, s.recipients.sent], ['sent', 100]);
  assert.equal(one(env, 'SELECT COUNT(DISTINCT email_norm) n FROM send_recipients').n, 100);
});

test('failures: a crash mid-chunk is never auto-resent; hard failures are reported; retry is deliberate', async () => {
  const env = await makeEnv({ SEND_CHUNK: '10', DRYRUN_FAIL: 'reader3@' });
  const c = await audience(env, 12);
  const send = await c.post('/api/admin/sends', { issue_slug: SLUG });
  await c.post(`/api/admin/sends/${send.data.id}/approve`);
  await c.post(`/api/admin/sends/${send.data.id}/schedule`, {});
  env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
  await tick(env);
  // simulate a crash: two recipients were claimed but no result was recorded
  env.DB.sqlite.prepare("UPDATE send_recipients SET status = 'sending', claimed_at = '2020-01-01T00:00:00Z' WHERE email_norm IN ('reader10@example.com','reader11@example.com')").run();
  await tickAll(env);
  const s = (await c.get(`/api/admin/sends/${send.data.id}`)).data;
  assert.deepEqual([s.status, s.recipients.sent, s.recipients.failed], ['sent', 9, 3]);
  assert.ok(s.failures.some((f) => /unconfirmed/.test(f.last_error)) && s.failures.some((f) => /simulated/.test(f.last_error)));
  env.DRYRUN_FAIL = '';
  await c.post(`/api/admin/sends/${send.data.id}/retry-failed`);
  await tickAll(env);
  assert.equal((await c.get(`/api/admin/sends/${send.data.id}`)).data.recipients.sent, 12);
});

test('test sends go only to authorised test inboxes; live providers are fenced in preview', async () => {
  const env = await makeEnv();
  const c = await audience(env, 3);
  assert.equal((await c.post('/api/admin/sends/test', { issue_slug: SLUG, emails: ['reader0@example.com'] })).status, 403);
  const t = await c.post('/api/admin/sends/test', { issue_slug: SLUG, emails: ['owner-test@example.com'] });
  assert.deepEqual([t.status, t.data.kind, t.data.status, t.data.recipients.sent], [201, 'test', 'sent', 1]);
  assert.ok(t.data.subject.startsWith('[TEST] '));
  // live mode in a preview environment: real audience is skipped, only the allowlisted inbox is contacted
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(JSON.stringify({ messageId: '<m1@brevo>' }), { status: 201 }); };
  try {
    const live = await makeEnv({ SEND_MODE: 'live', AUDIENCE_SENDING: 'enabled', BREVO_API_KEY: 'k', FROM_EMAIL: 'brief@prompted.example', REPLY_TO: 'owner@example.com' });
    const lc = await audience(live, 3, ['owner-test@example.com,active']);
    const send = await lc.post('/api/admin/sends', { issue_slug: SLUG });
    await lc.post(`/api/admin/sends/${send.data.id}/approve`);
    await lc.post(`/api/admin/sends/${send.data.id}/schedule`, {});
    live.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
    await tickAll(live);
    const s = (await lc.get(`/api/admin/sends/${send.data.id}`)).data;
    assert.deepEqual([s.recipients.sent, s.recipients.skipped], [1, 3]);
    assert.equal(calls.length, 1);
    const b = calls[0].body;
    assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
    assert.deepEqual([b.to[0].email, b.sender.email, b.replyTo.email], ['owner-test@example.com', 'brief@prompted.example', 'owner@example.com']);
    assert.match(b.headers['List-Unsubscribe'], /^<https:\/\/preview\.example\/u\/[a-f0-9]{40}>$/);
    assert.equal(b.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.ok(b.htmlContent.includes('/u/') && !b.htmlContent.includes('{{'));
    assert.equal(one(live, "SELECT count FROM provider_usage WHERE provider = 'brevo'").count, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('provider webhooks: bounces and complaints suppress; bad keys are rejected', async () => {
  const env = await makeEnv();
  const c = await audience(env, 3);
  const send = await c.post('/api/admin/sends', { issue_slug: SLUG });
  await c.post(`/api/admin/sends/${send.data.id}/approve`);
  await c.post(`/api/admin/sends/${send.data.id}/schedule`, {});
  env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
  await tickAll(env);
  assert.equal((await c.post('/api/hooks/brevo?key=wrong', { event: 'hard_bounce', email: 'reader0@example.com' })).status, 401);
  await c.post('/api/hooks/brevo?key=hook-secret', { event: 'delivered', email: 'reader1@example.com' });
  await c.post('/api/hooks/brevo?key=hook-secret', { event: 'hard_bounce', email: 'reader0@example.com', reason: 'mailbox does not exist' });
  await c.post('/api/hooks/resend?key=hook-secret', { type: 'email.complained', data: { to: ['reader2@example.com'] } });
  assert.deepEqual(many(env, 'SELECT email_norm, status FROM people ORDER BY id').map((p) => p.status), ['bounced', 'active', 'complained']);
  assert.deepEqual(many(env, 'SELECT reason FROM suppressions ORDER BY email_norm').map((s) => s.reason), ['bounced', 'complained']);
  assert.equal(one(env, "SELECT status FROM send_recipients WHERE email_norm = 'reader1@example.com'").status, 'delivered');
  // the next issue skips them
  const next = await c.post('/api/admin/sends', { issue_slug: 'week-of-october-25-november-1-2026' });
  await c.post(`/api/admin/sends/${next.data.id}/approve`);
  await c.post(`/api/admin/sends/${next.data.id}/schedule`, {});
  env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(next.data.id);
  await tickAll(env);
  assert.deepEqual(many(env, 'SELECT email_norm FROM send_recipients WHERE send_id = ?', next.data.id).map((r) => r.email_norm), ['reader1@example.com']);
});

test('historical metrics import keeps beehiiv figures verbatim and separate from platform figures', async () => {
  const env = await makeEnv(), c = client(env);
  await c.login();
  const payload = { captured_at: '2026-11-10T23:40:00Z', posts: [
    { post_id: 'post_86e6a01e-6fdd-4983-b1aa-b8497484ce89', email: { recipients: 10, delivered: 9, opens: 14, unique_opens: 7, clicks: 2, unique_clicks: 1, verified_clicks: 1, unique_verified_clicks: 1, unsubscribes: 1, spam_reports: 0 }, web: { views: 5, clicks: 1 } },
    { post_id: 'post_a68b58b7-2e8e-49b6-b9c0-3a36cdf50b30', email: { recipients: 0, delivered: 0 }, web: { views: 2, clicks: 1 } },
    { post_id: 'post_unknown', email: {}, web: {} } ] };
  const r = await c.post('/api/admin/metrics/beehiiv', payload);
  assert.deepEqual([r.data.imported, r.data.unmatched], [2, ['post_unknown']]);
  await c.post('/api/admin/metrics/beehiiv', payload); // idempotent
  assert.equal(one(env, 'SELECT COUNT(*) n FROM issue_metrics').n, 2);
  const dash = (await c.get('/api/admin/dashboard')).data;
  const nov = dash.issues.find((i) => i.slug === SLUG);
  assert.deepEqual([nov.beehiiv.recipients, nov.beehiiv.unique_opens, nov.beehiiv.bounces, nov.platform], [10, 7, 1, null]);
  assert.match(dash.issues.find((i) => i.number === 1).beehiiv.note, /Not emailed through beehiiv/);
  assert.ok(dash.notes.eras && dash.notes.opens);
  await c.post('/api/admin/metrics/growth', { series: [{ day: '2026-09-01', active: 46 }, { day: '2026-11-01', active: 128 }] });
  assert.equal((await c.get('/api/admin/dashboard')).data.growth_series.length, 2);
});

test('provider adapters: chain selection, Gmail MIME, header-injection guard', async () => {
  assert.deepEqual(providerChain({}).map((p) => p.name), ['dryrun'], 'dry-run unless SEND_MODE=live');
  assert.deepEqual(providerChain({ SEND_MODE: 'live', RESEND_API_KEY: 'x', BREVO_API_KEY: 'y', FROM_EMAIL: 'brief@prompted.example', EMAIL_PROVIDERS: 'resend,brevo,gmail' }).map((p) => p.name), ['resend', 'brevo']);
  assert.deepEqual(providerChain({ SEND_MODE: 'live', BREVO_API_KEY: 'y' }), [], 'a key without a sender address is not ready to send');
  assert.deepEqual(providerChain({ SEND_MODE: 'live' }), [], 'live with nothing configured sends nothing');
  assert.ok(brevo.dailyLimit({}) <= 300 && resend.dailyLimit({}) <= 100);
  const mime = buildMime({ from: { name: 'Prompted', email: 'a@gmail.test' }, to: 'r@example.com', subject: 'Prompted — Week of November 1–8, 2026', html: '<p>hi</p>', text: 'hi', headers: { 'List-Unsubscribe': '<https://x/u/1>' } });
  assert.match(mime, /^From: Prompted <a@gmail\.test>\r\nTo: <r@example\.com>\r\nSubject: =\?UTF-8\?B\?/);
  assert.ok(mime.includes('List-Unsubscribe: <https://x/u/1>') && mime.includes('multipart/alternative'));
  // a subject carrying a line break is encoded, so it cannot add a header
  assert.ok(!/^Bcc:/m.test(buildMime({ from: { name: 'P', email: 'a@b.c' }, to: 'r@example.com', subject: 'x\r\nBcc: evil@example.com', html: '', text: '' })));
  assert.throws(() => buildMime({ from: { name: 'P', email: 'a@b.c' }, to: 'r@example.com', subject: 'x', html: '', text: '', headers: { 'X-Test': 'a\r\nBcc: evil@example.com' } }));
});

test('admin password: generated high-entropy secret (sha256 scheme) and PBKDF2 both verify', async () => {
  const { verifyPassword, hashPassword, sha256 } = await import('../src/worker/core.mjs');
  const stored = 'sha256$abcd$' + (await sha256('abcd' + 'long-random-password'));
  assert.equal(await verifyPassword('long-random-password', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
  assert.equal(await verifyPassword('pw', await hashPassword('pw', 1000)), true);
  assert.equal(await verifyPassword('pw', ''), false);
  assert.equal(await verifyPassword('pw', 'plain$pw'), false);
});

test('Gmail connection: state-protected OAuth callback stores the token privately and enables the adapter', async () => {
  const env = await makeEnv({ GMAIL_CLIENT_ID: 'cid.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'csecret', SEND_MODE: 'live', EMAIL_PROVIDERS: 'gmail' }), c = client(env);
  assert.equal((await c.get('/api/admin/gmail/connect')).status, 401, 'connect requires the owner session');
  assert.equal((await c.get('/api/admin/gmail/callback?code=x&state=123.bad')).status, 400, 'forged state refused');
  await c.login();
  const go = await c.get('/api/admin/gmail/connect');
  assert.equal(go.status, 302);
  const loc = new URL(go.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://preview.example/api/admin/gmail/callback');
  assert.deepEqual([loc.searchParams.get('access_type'), loc.searchParams.get('scope')], ['offline', 'https://www.googleapis.com/auth/gmail.send openid email']);
  assert.equal((await c.get('/api/admin/providers')).data.gmail.connected, false);
  const calls = [], realFetch = globalThis.fetch;
  const idToken = 'h.' + Buffer.from(JSON.stringify({ email: 'sender@gmail.test' })).toString('base64url') + '.s';
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify(String(init.body).includes('authorization_code') ? { refresh_token: 'rt-1', scope: 'https://www.googleapis.com/auth/gmail.send openid', id_token: idToken } : { access_token: 'at-1', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ id: 'gmail-msg-1' }), { status: 200 });
  };
  try {
    c.dropCookie(); // the browser does not send the Strict cookie when Google redirects back
    const cb = await c.get(`/api/admin/gmail/callback?code=auth-code&state=${encodeURIComponent(loc.searchParams.get('state'))}`);
    assert.equal(cb.status, 303);
    await c.login();
    const prov = (await c.get('/api/admin/providers')).data;
    assert.deepEqual([prov.gmail.connected, prov.gmail.account, prov.quotas[0].name], [true, 'sender@gmail.test', 'gmail']);
    const backup = (await c.get('/api/admin/export/backup.json')).data;
    assert.ok(!JSON.stringify(backup).includes('rt-1'), 'the refresh token is never included in a backup');
    const t = await c.post('/api/admin/sends/test', { issue_slug: SLUG, emails: ['owner-test@example.com'] });
    assert.deepEqual([t.status, t.data.recipients.sent], [201, 1]);
    assert.ok(calls.some((u) => u.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')));
    await c.post('/api/admin/gmail/disconnect');
    assert.equal((await c.get('/api/admin/providers')).data.gmail.connected, false);
  } finally { globalThis.fetch = realFetch; }
});

test('staged send: a tagged pilot group first, then everyone else, nobody twice', async () => {
  const env = await makeEnv({ SEND_CHUNK: '50' });
  const c = await audience(env, 20);
  await c.post('/api/admin/people/bulk', { ids: [1, 2, 3], action: 'tag', value: 'pilot' });
  const send = await c.post('/api/admin/sends', { issue_slug: SLUG });
  await c.post(`/api/admin/sends/${send.data.id}/approve`);
  assert.equal((await c.post(`/api/admin/sends/${send.data.id}/extend`)).status, 409, 'cannot extend before it starts');
  const sch = await c.post(`/api/admin/sends/${send.data.id}/schedule`, { audience_tag: 'pilot' });
  assert.deepEqual(sch.data.audience, { tag: 'pilot' });
  env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
  await tickAll(env);
  let s = (await c.get(`/api/admin/sends/${send.data.id}`)).data;
  assert.deepEqual([s.status, s.recipients.sent, s.not_yet_included], ['sent', 3, 17]);
  env.DB.sqlite.prepare("UPDATE people SET status = 'unsubscribed' WHERE id = 20").run();
  env.DB.sqlite.prepare("INSERT INTO suppressions (email_norm, reason, source, created_at) VALUES ('reader19@example.com', 'unsubscribed', 'platform', '2026-01-01')").run();
  s = (await c.post(`/api/admin/sends/${send.data.id}/extend`)).data;
  assert.deepEqual([s.status, s.recipients.queued], ['sending', 16]);
  await tickAll(env);
  s = (await c.get(`/api/admin/sends/${send.data.id}`)).data;
  assert.deepEqual([s.status, s.recipients.sent, s.not_yet_included], ['sent', 19, 0]);
  assert.equal(one(env, 'SELECT COUNT(DISTINCT email_norm) n FROM send_recipients').n, 19);
  assert.equal(one(env, "SELECT COUNT(*) n FROM delivery_events WHERE type = 'sent'").n, 19);
});

test('Gmail limits and expired sign-in pause a send without burning attempts or losing anyone', async () => {
  const env = await makeEnv({ SEND_MODE: 'live', AUDIENCE_SENDING: 'enabled', EMAIL_PROVIDERS: 'gmail', GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'cs', GMAIL_REFRESH_TOKEN: 'rt', GMAIL_FROM_EMAIL: 'sender@gmail.test', SITE_ENV: 'production', SEND_CHUNK: '10' });
  const c = await audience(env, 6);
  const send = await c.post('/api/admin/sends', { issue_slug: SLUG });
  await c.post(`/api/admin/sends/${send.data.id}/approve`);
  await c.post(`/api/admin/sends/${send.data.id}/schedule`, {});
  env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
  let sends = 0, mode = 'limit';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return mode === 'revoked' ? new Response('{"error":"invalid_grant"}', { status: 400 }) : new Response('{"access_token":"at","expires_in":1}', { status: 200 });
    sends++;
    if (mode === 'limit' && sends > 2) return new Response('{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}', { status: 403 });
    return new Response('{"id":"m' + sends + '"}', { status: 200 });
  };
  try {
    await tick(env);
    let s = (await c.get(`/api/admin/sends/${send.data.id}`)).data;
    assert.deepEqual([s.status, s.recipients.sent, s.recipients.queued], ['sending', 2, 4], 'stops at the limit');
    assert.equal(sends, 3, 'no further calls after Gmail says stop');
    assert.equal(one(env, "SELECT MAX(attempts) a FROM send_recipients WHERE status = 'queued'").a, 0);
    assert.match((await c.get('/api/admin/providers')).data.last_problem.message, /gmail limit reached/);
    mode = 'revoked'; await new Promise((r) => setTimeout(r, 5));
    env.DB.sqlite.prepare('DELETE FROM provider_usage').run();
    await tick(env);
    s = (await c.get(`/api/admin/sends/${send.data.id}`)).data;
    assert.deepEqual([s.recipients.sent, s.recipients.queued, s.recipients.failed], [2, 4, undefined], 'expired sign-in: everyone stays queued');
    assert.match((await c.get('/api/admin/providers')).data.last_problem.message, /Reconnect Gmail/);
    mode = 'ok';
    await tickAll(env);
    s = (await c.get(`/api/admin/sends/${send.data.id}`)).data;
    assert.deepEqual([s.status, s.recipients.sent], ['sent', 6]);
  } finally { globalThis.fetch = realFetch; }
});

test('migration tooling: column mapping, custom fields kept, reconcile report flags dangerous differences', async () => {
  const env = await makeEnv(), c = client(env);
  await c.login();
  const ledger = 'Subscriber,State,Joined,Favourite Topic,Plan\na@example.com,active,2026-09-01T00:00:00Z,agents,free\nb@example.com,inactive,2026-09-02T00:00:00Z,,free\nc@example.com,active,2026-09-03T00:00:00Z,chips,free\n';
  const pre = await c.post('/api/admin/imports/preview', { csv: ledger, mode: 'migration', source_label: 'x' });
  assert.deepEqual([pre.status, pre.data.needs_mapping, pre.data.headers.length], [200, true, 5], 'no email column recognised: the dashboard asks which one it is');
  assert.equal((await c.post('/api/admin/imports/commit', { csv: ledger, mode: 'migration', source_label: 'x' })).status, 400);
  const mapping = { Subscriber: 'email', State: 'status', Joined: 'subscribed_at', Bogus: 'email', Plan: 'not_a_field' };
  const plan = await c.post('/api/admin/imports/preview', { csv: ledger, mode: 'migration', source_label: 'x', mapping });
  assert.deepEqual(plan.data.mapping, { Subscriber: 'email', State: 'status', Joined: 'subscribed_at' }, 'unknown headers and fields are dropped');
  assert.ok(plan.data.fields.includes('institution_id'));
  await c.post('/api/admin/imports/commit', { csv: ledger, mode: 'migration', source_label: 'x', mapping });
  assert.deepEqual(JSON.parse(one(env, "SELECT custom FROM people WHERE email_norm = 'a@example.com'").custom), { 'Favourite Topic': 'agents', Plan: 'free' });
  let r = (await c.post('/api/admin/imports/reconcile', { csv: ledger, mapping })).data;
  assert.deepEqual([r.in_agreement, r.matching, r.source_counts, r.database_counts], [true, 3, { active: 2, unsubscribed: 1 }, { active: 2, unsubscribed: 1 }]);
  // drift: someone unsubscribed in the source, someone new appeared there, someone exists only here
  const later = ledger.replace('c@example.com,active', 'c@example.com,inactive') + 'd@example.com,active,2026-10-01T00:00:00Z,,free\nnot-an-address,active,,,\n';
  await c.post('/api/admin/people', { email: 'local@example.com' });
  r = (await c.post('/api/admin/imports/reconcile', { csv: later, mapping })).data;
  assert.equal(r.in_agreement, false);
  assert.deepEqual(r.missing_from_database, [{ email: 'd@example.com', source_status: 'active' }]);
  assert.deepEqual(r.only_in_database, [{ email: 'local@example.com', status: 'prospective' }]);
  assert.deepEqual(r.dangerous, [{ email: 'c@example.com', source_status: 'unsubscribed', status: 'active' }]);
  assert.equal(r.invalid.length, 1);
  assert.equal(one(env, "SELECT status FROM people WHERE email_norm = 'c@example.com'").status, 'active', 'reconcile changes nothing');
  // importing the newer ledger applies the opt-out and never the reverse
  await c.post('/api/admin/imports/commit', { csv: later.replace('not-an-address,active,,,\n', ''), mode: 'migration', source_label: 'x', mapping });
  assert.equal(one(env, "SELECT status FROM people WHERE email_norm = 'c@example.com'").status, 'unsubscribed');
  assert.equal((await c.post('/api/admin/imports/reconcile', { csv: later.replace('not-an-address,active,,,\n', ''), mapping })).data.dangerous.length, 0);
});

test('dashboard pages carry a strict content security policy', async () => {
  const env = await makeEnv(), c = client(env);
  const r = await c.get('/admin/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal((await c.get('/')).headers.get('content-security-policy'), null);
});

test('with Gmail connected but audience sending in dry run: tests go out for real, the audience does not', async () => {
  const env = await makeEnv({ GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'cs', GMAIL_REFRESH_TOKEN: 'rt-test-mode', GMAIL_FROM_EMAIL: 'sender@gmail.test' });
  const c = await audience(env, 4);
  const calls = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return String(url).includes('oauth2') ? new Response('{"access_token":"at","expires_in":3600}') : new Response('{"id":"g1"}'); };
  try {
    const prov = (await c.get('/api/admin/providers')).data;
    assert.deepEqual([prov.send_mode, prov.quotas[0].name, prov.test_quotas[0].name], ['dryrun', 'dryrun', 'gmail']);
    const t = await c.post('/api/admin/sends/test', { issue_slug: SLUG, emails: ['owner-test@example.com'] });
    assert.deepEqual([t.data.recipients.sent, t.data.providers], [1, ['gmail']]);
    assert.equal(calls.filter((u) => u.includes('messages/send')).length, 1);
    assert.equal((await c.post('/api/admin/sends/test', { issue_slug: SLUG, emails: ['reader0@example.com'] })).status, 403, 'still only authorised inboxes');
    const send = await c.post('/api/admin/sends', { issue_slug: SLUG });
    await c.post(`/api/admin/sends/${send.data.id}/approve`);
    await c.post(`/api/admin/sends/${send.data.id}/schedule`, {});
    env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z' WHERE kind = 'issue'").run();
    await tickAll(env);
    const s = (await c.get(`/api/admin/sends/${send.data.id}`)).data;
    assert.deepEqual([s.status, s.recipients.sent, s.providers], ['sent', 4, ['dryrun']]);
    assert.equal(calls.filter((u) => u.includes('messages/send')).length, 1, 'no real email to the audience in dry-run mode');
  } finally { globalThis.fetch = realFetch; }
});

test('test sends to a test inbox that is also a subscriber carry real unsubscribe and tracking links; Gmail health is recorded', async () => {
  const env = await makeEnv({ GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'cs', GMAIL_REFRESH_TOKEN: 'rt-health', GMAIL_FROM_EMAIL: 'sender@gmail.test', TRACK_OPENS: 'true', TRACK_CLICKS: 'true', PREVIEW_CONFIRMATIONS: 'live' }), c = client(env);
  const sent = [], realFetch = globalThis.fetch;
  let tokenBody = { access_token: 'at', expires_in: 3600, refresh_token_expires_in: 500000 };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('oauth2')) return new Response(JSON.stringify(tokenBody), { status: tokenBody.error ? 400 : 200 });
    sent.push(Buffer.from(JSON.parse(init.body).raw, 'base64url').toString()); return new Response('{"id":"g"}');
  };
  try {
    // with the owner's switch on, a signup with the authorised test inbox gets a real confirmation email
    const r = await signup(c, 'owner-test@example.com', { utm_source: 'owner_test' });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Subject: Confirm your subscription to Prompted/);
    await signup(c, 'stranger@example.com');
    assert.equal(sent.length, 1, 'a stranger signing up on the preview gets no real email');
    await c.post(r.data.dev_confirm_url);
    const person = one(env, "SELECT id, token FROM people WHERE email_norm = 'owner-test@example.com'");
    await c.login();
    const t = await c.post('/api/admin/sends/test', { issue_slug: 'week-of-august-9-16-2026', emails: ['owner-test@example.com'] });
    assert.deepEqual([t.data.recipients.sent, t.data.providers], [1, ['gmail']]);
    assert.deepEqual(t.data.links.map((l) => l.kind).sort(), ['body', 'template', 'template', 'template'], 'one distinct link in the issue plus the template\'s web, Index and forward links');
    const trackId = one(env, 'SELECT track_id FROM send_recipients WHERE send_id = ?', t.data.id).track_id;
    const bodyIdx = t.data.links.find((l) => l.kind === 'body').idx;
    const mime = sent[1], html = Buffer.from(mime.split('Content-Transfer-Encoding: base64\r\n\r\n')[2].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString();
    assert.ok(mime.includes(`List-Unsubscribe: <https://preview.example/u/${person.token}>`) && mime.includes('List-Unsubscribe-Post: List-Unsubscribe=One-Click'));
    assert.ok(html.includes(`https://preview.example/u/${person.token}`) && html.includes(`/r/${trackId}/${bodyIdx}`) && html.includes(`/o/${trackId}.gif`));
    assert.ok(!html.replace(`/u/${person.token}`, '').includes(person.token), 'the subscriber token appears only in the unsubscribe link, never in tracking URLs');
    assert.ok(mime.startsWith('From: Prompted <sender@gmail.test>\r\nTo: <owner-test@example.com>\r\nSubject: =?UTF-8?B?'));
    // a tracked link forwards to the original address and is counted; unsubscribe really unsubscribes
    const click = await c.get(`/r/${trackId}/${bodyIdx}`);
    assert.equal(click.status, 302);
    assert.equal(click.headers.get('location'), new URL(one(env, 'SELECT url FROM send_links WHERE send_id = ? AND idx = ?', t.data.id, bodyIdx).url).href);
    await c.get(`/o/${trackId}.gif`);
    const after = (await c.get(`/api/admin/sends/${t.data.id}`)).data;
    assert.deepEqual([after.opened, after.clicked, after.links[0].clicks], [1, 1, 1]);
    await c.post(`/u/${person.token}`);
    assert.equal(one(env, 'SELECT status FROM people WHERE id = ?', person.id).status, 'unsubscribed');
    // health check: working, with the 7-day expiry Google reports for an app in Testing mode
    let h = (await c.post('/api/admin/gmail/check')).data.health;
    assert.equal(h.ok, true);
    assert.ok(new Date(h.expires_at) - Date.now() > 5 * 864e5 && new Date(h.expires_at) - Date.now() < 6 * 864e5);
    assert.ok((await c.get('/api/admin/dashboard')).data.gmail_health.expires_at);
    tokenBody = { error: 'invalid_grant' };
    h = (await c.post('/api/admin/gmail/check')).data.health;
    assert.deepEqual([h.ok, /expired or was revoked/.test(h.error)], [false, true]);
  } finally { globalThis.fetch = realFetch; }
});

test('warm-up ramp caps real sending per day and grows gradually; tracking is off unless switched on', async () => {
  const { warmupCap } = await import('../src/worker/sending.mjs');
  assert.equal(warmupCap({}), null);
  assert.equal(warmupCap({ WARMUP: '2026-12-01,20,1.25' }, new Date('2026-11-30T23:00:00Z')), 0, 'nothing before the start date');
  assert.deepEqual([0, 1, 2, 7, 14].map((d) => warmupCap({ WARMUP: '2026-12-01,20,1.25' }, new Date(Date.UTC(2026, 11, 1 + d, 12)))), [20, 25, 31, 95, 454]);
  const start = new Date().toISOString().slice(0, 10);
  const env = await makeEnv({ SEND_MODE: 'live', AUDIENCE_SENDING: 'enabled', SITE_ENV: 'production', EMAIL_PROVIDERS: 'brevo', BREVO_API_KEY: 'k', FROM_EMAIL: 'brief@prompted.example', WARMUP: `${start},5,1.5`, SEND_CHUNK: '50' });
  const c = await audience(env, 12);
  const bodies = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{"messageId":"m"}', { status: 201 }); };
  try {
    const q = (await c.get('/api/admin/providers')).data.quotas[0];
    assert.deepEqual([q.name, q.limit, q.warmup_cap], ['brevo', 5, 5]);
    const send = await c.post('/api/admin/sends', { issue_slug: 'week-of-august-9-16-2026' });
    await c.post(`/api/admin/sends/${send.data.id}/approve`);
    await c.post(`/api/admin/sends/${send.data.id}/schedule`, {});
    env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
    env.QUOTA_RESERVE = '0';
    for (let i = 0; i < 4; i++) await tick(env);
    const s = (await c.get(`/api/admin/sends/${send.data.id}`)).data;
    assert.deepEqual([s.status, s.recipients.sent, s.recipients.queued], ['sending', 5, 7], 'day one stops at the warm-up cap');
    const html = bodies[0].htmlContent;
    assert.ok(!html.includes('/r/') && !html.includes('/o/') && html.includes('https://'), 'no tracking redirects or pixels by default');
    assert.ok(!/&#847;|&zwnj;/.test(html), 'no invisible padding characters');
    assert.ok(html.includes('/u/'), 'the unsubscribe link is always present');
  } finally { globalThis.fetch = realFetch; }
});

test('sending-domain check reads SPF, DKIM and DMARC and explains what is missing', async () => {
  const env = await makeEnv(), c = client(env);
  await c.login();
  const zone = { 'good.example': { TXT: ['"v=spf1 include:spf.brevo.com ~all"'], MX: ['10 mx.good.example.'] }, '_dmarc.good.example': { TXT: ['"v=DMARC1; p=quarantine; rua=mailto:d@good.example"'] }, 'brevo1._domainkey.good.example': { CNAME: ['b1.good-example.dkim.brevo.com.'] },
    'bad.example': { TXT: ['"v=spf1 +all"', '"v=spf1 include:x ~all"'] } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { const u = new URL(url); return new Response(JSON.stringify({ Answer: ((zone[u.searchParams.get('name')] || {})[u.searchParams.get('type')] || []).map((data) => ({ data })) })); };
  try {
    const good = (await c.get('/api/admin/deliverability/domain?domain=Good.Example')).data;
    assert.deepEqual([good.ready, good.dkim, good.findings.map((f) => f.level)], [true, { brevo: 'brevo1' }, ['ok', 'ok', 'ok', 'ok']]);
    const bad = (await c.get('/api/admin/deliverability/domain?domain=bad.example')).data;
    assert.equal(bad.ready, false);
    assert.deepEqual(bad.findings.filter((f) => f.level === 'error').map((f) => f.item), ['SPF', 'DMARC', 'DKIM']);
    assert.equal((await c.get('/api/admin/deliverability/domain?domain=gmail.com')).data.ready, false);
    assert.equal((await c.get('/api/admin/deliverability/domain?domain=not a domain')).status, 400);
    c.dropCookie();
    assert.equal((await c.get('/api/admin/deliverability/domain?domain=good.example')).status, 401);
  } finally { globalThis.fetch = realFetch; }
});

test('inbox placement log: results are recorded and the three-in-a-row gate is computed per sender and inbox', async () => {
  const env = await makeEnv(), c = client(env);
  assert.equal((await c.get('/api/admin/placement')).status, 401);
  await c.login();
  assert.equal((await c.post('/api/admin/placement', { tested_on: 'yesterday', sender: 'a', inbox: 'Gmail', result: 'inbox' })).status, 400);
  const add = (d, sender, inbox, result) => c.post('/api/admin/placement', { tested_on: d, sender, inbox, result });
  await add('2026-11-11', 'sender@gmail.test', 'Gmail', 'spam');
  for (const d of ['2026-11-20', '2026-11-21', '2026-11-22']) await add(d, 'brief@prompted.example', 'Gmail', 'inbox');
  await add('2026-11-20', 'brief@prompted.example', 'Outlook', 'inbox');
  await add('2026-11-21', 'brief@prompted.example', 'Outlook', 'spam');
  await add('2026-11-22', 'brief@prompted.example', 'Outlook', 'inbox');
  const r = (await c.get('/api/admin/placement')).data;
  const by = Object.fromEntries(r.streaks.map((s) => [s.sender + '|' + s.inbox, s]));
  assert.deepEqual([by['brief@prompted.example|Gmail'].streak, by['brief@prompted.example|Gmail'].passes], [3, true]);
  assert.deepEqual([by['brief@prompted.example|Outlook'].streak, by['brief@prompted.example|Outlook'].passes], [1, false], 'a spam result resets the run');
  assert.deepEqual([by['sender@gmail.test|Gmail'].streak, by['sender@gmail.test|Gmail'].last], [0, 'spam']);
  assert.equal((await c.get('/api/admin/export/backup.json')).data.tables.placement_tests.length, 7);
  const h = (await c.get('/')).headers;
  assert.ok(h.get('strict-transport-security') && h.get('permissions-policy'));
});

test('tag everyone matching a filter, optionally only the first N longest-standing, to build a pilot group', async () => {
  const env = await makeEnv(), c = client(env);
  await c.login();
  const csv = ['email,status,subscribed_at,organizations', ...Array.from({ length: 10 }, (_, i) => `r${i}@example.com,${i === 9 ? 'inactive' : 'active'},2026-0${1 + i % 9}-01T00:00:00Z,${i % 2 ? 'Founders' : 'AWE'}`)].join('\n');
  await c.post('/api/admin/imports/commit', { csv, mode: 'migration', source_label: 'synthetic' });
  assert.equal((await c.post('/api/admin/people/tag-filtered', { tag: '' })).status, 400);
  let r = (await c.post('/api/admin/people/tag-filtered', { tag: 'pilot', filters: { status: 'active' }, limit: 3 })).data;
  assert.deepEqual([r.changed, r.tagged_total], [3, 3]);
  assert.deepEqual(many(env, "SELECT p.email_norm FROM person_tags t JOIN people p ON p.id = t.person_id WHERE t.tag = 'pilot' ORDER BY p.email_norm").map((x) => x.email_norm), ['r0@example.com', 'r1@example.com', 'r2@example.com'], 'longest-standing first');
  r = (await c.post('/api/admin/people/tag-filtered', { tag: 'founders-active', filters: { status: 'active', org: 'Founders' } })).data;
  assert.equal(r.changed, 4, 'r1, r3, r5, r7 (r9 is unsubscribed)');
  r = (await c.post('/api/admin/people/tag-filtered', { tag: 'pilot', filters: { status: 'active' }, limit: 3 })).data;
  assert.deepEqual([r.changed, r.tagged_total], [0, 3], 'running it again changes nothing');
  r = (await c.post('/api/admin/people/tag-filtered', { tag: 'pilot', filters: {}, remove: true })).data;
  assert.deepEqual([r.changed, r.tagged_total], [3, 0]);
  c.dropCookie();
  assert.equal((await c.post('/api/admin/people/tag-filtered', { tag: 'x' })).status, 401);
});

test('draft check: pasted approved text becomes an issue with QA, a file to download and an exact email preview; nothing is published', async () => {
  const env = await makeEnv(), c = client(env);
  const text = ['# Week of November 8–15, 2026', '> A one-line summary for the preview.', '', 'An opening paragraph that frames the week in one go.', '',
    '## The Biggest Developments', '', '### A Story Headline', '', 'A body paragraph with **bold words** and [a link](https://example.com/story).', '',
    '## Worth Knowing Briefly', '', 'A brief item.', '', '## Patterns Worth Watching', '', 'A pattern.', '', '## Why This Week Matters', '',
    '**If you are a student,** a takeaway.', '', 'That’s the week. See you next Monday.', '', '— Prompted'].join('\n');
  assert.equal((await c.post('/api/admin/issues/draft', { text })).status, 401);
  await c.login();
  assert.equal((await c.get('/api/admin/issues/draft/email')).status, 404);
  const d = (await c.post('/api/admin/issues/draft', { text })).data;
  assert.deepEqual([d.issue.number, d.issue.slug, d.filename, d.already_published], [32, 'week-of-november-8-15-2026', '032-week-of-november-8-15-2026.json', false]);
  assert.equal(d.qa.ok, true, JSON.stringify(d.qa.findings));
  assert.equal(d.subject, 'Prompted | Your Weekly AI Brief | Week of November 8–15');
  assert.equal(d.issue.blocks.find((b) => b.role === 'closing').children[0].text, 'That’s the week. See you next Monday.');
  assert.match(d.issue.source.content_sha256, /^[a-f0-9]{64}$/);
  const email = String((await c.get('/api/admin/issues/draft/email')).data);
  assert.ok(email.includes('Week of November 8–15') && email.includes('A Story Headline') && email.includes('https://example.com/story'));
  // a draft with house-format problems is reported, not rejected
  const bad = (await c.post('/api/admin/issues/draft', { text: text.replace('That’s the week. See you next Monday.', 'See you next week!').replace('## Worth Knowing Briefly\n\nA brief item.\n\n', '') })).data;
  assert.equal(bad.qa.ok, false);
  assert.ok(bad.qa.findings.some((f) => f.code === 'closing') && bad.qa.findings.some((f) => f.code === 'sections-missing'));
  assert.equal((await c.post('/api/admin/issues/draft', { text: 'no title line' })).status, 400);
  // an existing week is flagged; the published list is untouched
  const dup = (await c.post('/api/admin/issues/draft', { text: text.replace('November 8–15, 2026', 'November 1–8, 2026') })).data;
  assert.equal(dup.already_published, true);
  assert.equal((await c.get('/api/admin/issues')).data.issues.length, 31);
});

test('www is redirected to the bare domain; the Gmail sign-in returns to the address in use', async () => {
  const worker = (await import('../src/worker/index.mjs')).default;
  const env = await makeEnv({ GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'cs' });
  const r = await worker.fetch(new Request('https://www.readprompted.example/issues/?q=1'), env);
  assert.deepEqual([r.status, r.headers.get('location')], [301, 'https://readprompted.example/issues/?q=1']);
  const c = client(env);
  await c.login();
  const go = await c.get('/api/admin/gmail/connect');
  assert.equal(new URL(go.headers.get('location')).searchParams.get('redirect_uri'), 'https://preview.example/api/admin/gmail/callback');
  assert.equal((await c.get('/api/admin/providers')).data.gmail.redirect_uri, 'https://preview.example/api/admin/gmail/callback');
});

test('Brevo status and one-click setup: reports what is missing, registers the sender and delivery reports once, sends nothing', async () => {
  const env = await makeEnv(), c = client(env);
  assert.equal((await c.get('/api/admin/brevo/status')).status, 401);
  await c.login();
  assert.equal((await c.get('/api/admin/brevo/status')).data.configured, false);
  assert.equal((await c.post('/api/admin/brevo/setup')).status, 400);
  env.BREVO_API_KEY = 'k'; env.FROM_EMAIL = 'brief@prompted.example';
  const state = { senders: [], webhooks: [], authenticated: false, relay: false }, calls = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), m = init.method || 'GET'; calls.push(m + ' ' + u.pathname);
    const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (init.headers['api-key'] !== 'k') return j({ message: 'Key not found' }, 401);
    if (u.pathname === '/v3/account') return j({ plan: [{ type: 'free', credits: 300 }], relay: { enabled: state.relay } });
    if (u.pathname === '/v3/senders/domains') return j({ domains: [{ domain_name: 'prompted.example', authenticated: state.authenticated, verified: true }] });
    if (u.pathname === '/v3/senders' && m === 'GET') return j({ senders: state.senders });
    if (u.pathname === '/v3/senders' && m === 'POST') { state.senders.push({ ...JSON.parse(init.body), active: true }); return j({ id: 1 }, 201); }
    if (u.pathname === '/v3/webhooks' && m === 'GET') return j({ webhooks: state.webhooks });
    if (u.pathname === '/v3/webhooks' && m === 'POST') { state.webhooks.push(JSON.parse(init.body)); return j({ id: 9 }, 201); }
    return j({}, 404);
  };
  try {
    let st = (await c.get('/api/admin/brevo/status')).data;
    assert.deepEqual([st.key_valid, st.domain.authenticated, st.sender, st.delivery_reports, st.ready], [true, false, null, false, false]);
    assert.match(st.next, /click Authenticate/);
    state.authenticated = true;
    assert.match((await c.get('/api/admin/brevo/status')).data.next, /Finish Brevo setup/);
    const done = (await c.post('/api/admin/brevo/setup')).data;
    assert.deepEqual(done.done, ['sender added', 'delivery reports registered']);
    assert.deepEqual([state.senders[0].email, state.senders[0].name], ['brief@prompted.example', 'Prompted']);
    assert.equal(state.webhooks[0].url, 'https://preview.example/api/hooks/brevo?key=hook-secret');
    assert.deepEqual([state.webhooks[0].type, state.webhooks[0].events.includes('hardBounce'), state.webhooks[0].events.includes('spam')], ['transactional', true, true]);
    assert.deepEqual((await c.post('/api/admin/brevo/setup')).data.done, ['sender already present', 'delivery reports already registered'], 'running it twice changes nothing');
    st = (await c.get('/api/admin/brevo/status')).data;
    assert.match(st.next, /Ask Brevo support/);
    state.relay = true;
    st = (await c.get('/api/admin/brevo/status')).data;
    assert.deepEqual([st.ready, st.next], [true, 'Ready for an approved test send.']);
    assert.ok(!calls.some((x) => x.includes('/smtp/email')), 'no email is sent by status or setup');
    assert.ok(!JSON.stringify(st).includes('hook-secret'), 'the webhook secret is never returned to the browser');
    env.BREVO_API_KEY = 'wrong';
    assert.equal((await c.get('/api/admin/brevo/status')).data.key_valid, false);
  } finally { globalThis.fetch = realFetch; }
});

test('on the preview, the public signup form cannot trigger a real email, even for the test inbox, unless the owner switched it on', async () => {
  const env = await makeEnv({ GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'cs', GMAIL_REFRESH_TOKEN: 'rt-guard', GMAIL_FROM_EMAIL: 'sender@gmail.test', BREVO_API_KEY: 'k', FROM_EMAIL: 'brief@prompted.example' }), c = client(env);
  const calls = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response('{}'); };
  try {
    await signup(c, 'owner-test@example.com');
    await signup(c, 'stranger@example.com');
    assert.deepEqual(calls, [], 'no provider was contacted');
    assert.equal(one(env, "SELECT COUNT(*) n FROM delivery_events WHERE type = 'confirmation_sent' AND provider = 'dryrun'").n, 2);
  } finally { globalThis.fetch = realFetch; }
});

test('Amazon SES: request signing matches the published AWS example; single sends carry unsubscribe headers; the sandbox keeps SES out of the chain', async () => {
  // The "get-vanilla" case from the AWS Signature Version 4 test suite.
  const signed = await awsSign({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service', method: 'GET', host: 'example.amazonaws.com', path: '/', at: new Date('2015-08-30T12:36:00Z') });
  assert.equal(signed['x-amz-date'], '20150830T123600Z');
  assert.equal(signed.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');

  const keys = { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', SES_REGION: 'us-east-2', FROM_EMAIL: 'brief@prompted.example', SES_CONFIGURATION_SET: 'prompted' };
  const sandbox = { ...keys, SES_ACCOUNT: { production_access: false, max_24h: 200, max_rate: 1 } };
  const approved = { ...keys, SES_ACCOUNT: { production_access: true, max_24h: 50000, max_rate: 14 } };
  assert.equal(ses.configured(keys), false, 'Amazon limits never read: not used');
  assert.equal(ses.configured(sandbox), false, 'sandbox: not used, tests go through Brevo instead');
  assert.equal(ses.configured({ ...sandbox, SES_USE_IN_SANDBOX: 'true' }), true);
  assert.equal(ses.configured({ ...approved, FROM_EMAIL: '' }), false, 'keys without a sender address are not ready');
  assert.deepEqual([ses.configured(approved), ses.dailyLimit(approved), ses.dailyLimit(keys), ses.dailyLimit({ ...approved, SES_DAILY_LIMIT: '1000' })], [true, 45000, 190, 1000]);
  assert.deepEqual(providerChain({ ...approved, SEND_MODE: 'live', BREVO_API_KEY: 'k' }).map((p) => p.name), ['ses', 'brevo'], 'SES first, Brevo as fallback');
  assert.deepEqual(providerChain({ ...sandbox, SEND_MODE: 'live', BREVO_API_KEY: 'k' }).map((p) => p.name), ['brevo']);
  // pacing follows Amazon's per-second rate
  assert.deepEqual(ses.batchPlan(approved), { perCall: 14, calls: 4, spacingMs: 1112, perMinute: 56 });
  assert.deepEqual(ses.batchPlan({ ...approved, SES_ACCOUNT: { production_access: true, max_rate: 100 } }).perCall, 50, 'never more than 50 people in one request');

  const calls = [], realFetch = globalThis.fetch;
  let answer = () => new Response(JSON.stringify({ MessageId: 'ses-1' }), { status: 200 });
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return answer(); };
  try {
    const msg = { from: { name: 'Prompted', email: 'brief@prompted.example' }, replyTo: null, to: 'reader@example.com', subject: 'Prompted | Week of November 1–8', html: '<p>hi</p>', text: 'hi', headers: { 'List-Unsubscribe': '<https://x/u/1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
    assert.deepEqual(await ses.send(approved, msg), { ok: true, id: 'ses-1' });
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(calls[0].url, 'https://email.us-east-2.amazonaws.com/v2/email/outbound-emails');
    assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-2\/ses\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(calls[0]).includes('"secret"'), 'the secret key is never sent');
    assert.deepEqual([sent.FromEmailAddress, sent.Destination.ToAddresses, sent.ConfigurationSetName, sent.Content.Simple.Subject.Data], ['"Prompted" <brief@prompted.example>', ['reader@example.com'], 'prompted', msg.subject]);
    assert.deepEqual(sent.Content.Simple.Headers, [{ Name: 'List-Unsubscribe', Value: '<https://x/u/1>' }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }]);
    await assert.rejects(() => ses.send(approved, { ...msg, subject: 'x\r\nBcc: evil@example.com' }), /Header injection/);
    answer = () => new Response(JSON.stringify({ message: 'Maximum sending rate exceeded.' }), { status: 429, headers: { 'x-amzn-errortype': 'TooManyRequestsException' } });
    assert.equal((await ses.send(approved, msg)).rateLimited, true, 'a rate limit pauses the send instead of failing people');
    answer = () => new Response(JSON.stringify({ message: 'not authorized to perform: ses:SendEmail' }), { status: 403, headers: { 'x-amzn-errortype': 'AccessDeniedException' } });
    assert.equal((await ses.send(approved, msg)).authError, true);
    answer = () => new Response(JSON.stringify({ message: 'Email address is not verified.' }), { status: 400, headers: { 'x-amzn-errortype': 'MessageRejected' } });
    const rejected = await ses.send(approved, msg);
    assert.deepEqual([rejected.ok, rejected.retryable, !!rejected.rateLimited], [false, false, false]);
  } finally { globalThis.fetch = realFetch; }
});

test('Amazon SES bulk: a whole issue goes out in requests of up to a second of recipients, each with their own unsubscribe link and header; failures are sorted correctly', async () => {
  const n = 40;
  const env = await makeEnv({ SEND_MODE: 'live', AUDIENCE_SENDING: 'enabled', SITE_ENV: 'production', EMAIL_PROVIDERS: 'ses', SES_BULK: 'on', SES_CALL_SPACING_MS: '0', AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 's', FROM_EMAIL: 'brief@prompted.example', SES_CONFIGURATION_SET: 'prompted-newsletter', QUOTA_RESERVE: '0' });
  env.DB.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('ses_account', ?)").run(JSON.stringify({ production_access: true, sending_enabled: true, max_24h: 50000, max_rate: 14 }));
  const c = await audience(env, n);
  const requests = [], realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body); requests.push({ url: String(url), b }); call++;
    return new Response(JSON.stringify({ BulkEmailEntryResults: b.BulkEmailEntries.map((e, i) => {
      const to = e.Destination.ToAddresses[0];
      if (to === 'reader3@example.com') return { Status: 'MESSAGE_REJECTED', Error: 'Email address is on the suppression list' };
      if (call === 3 && i === 5) return { Status: 'ACCOUNT_THROTTLED', Error: 'Maximum sending rate exceeded.' };
      return { Status: 'SUCCESS', MessageId: 'm-' + to };
    }) }), { status: 200 });
  };
  try {
    const send = await c.post('/api/admin/sends', { issue_slug: 'week-of-august-9-16-2026' });
    await c.post(`/api/admin/sends/${send.data.id}/approve`);
    await c.post(`/api/admin/sends/${send.data.id}/schedule`, {});
    env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
    await tick(env);
    assert.equal(requests.length, 3, '40 people at 14 a request');
    assert.ok(requests.every((r) => r.url === 'https://email.us-east-1.amazonaws.com/v2/email/outbound-bulk-emails'));
    assert.deepEqual(requests.map((r) => r.b.BulkEmailEntries.length), [14, 14, 12]);
    const first = requests[0].b, tpl = first.DefaultContent.Template.TemplateContent;
    assert.equal(first.ConfigurationSetName, 'prompted-newsletter');
    assert.equal(first.FromEmailAddress, '"Prompted" <brief@prompted.example>');
    assert.ok(tpl.Html.includes('https://preview.example/u/{{TOKEN}}') && tpl.Text.includes('https://preview.example/u/{{TOKEN}}'), 'the unsubscribe link carries each person\'s token');
    assert.equal(tpl.Html.split('{{').length - 1, tpl.Html.split('{{TOKEN}}').length - 1, 'no other placeholder reaches Amazon');
    const people = Object.fromEntries(many(env, 'SELECT email_norm, token FROM people').map((p) => [p.email_norm, p.token]));
    for (const e of first.BulkEmailEntries) {
      const to = e.Destination.ToAddresses[0], tok = people[to];
      assert.equal(JSON.parse(e.ReplacementEmailContent.ReplacementTemplate.ReplacementTemplateData).TOKEN, tok);
      assert.deepEqual(e.ReplacementHeaders, [{ Name: 'List-Unsubscribe', Value: `<https://preview.example/u/${tok}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }]);
    }
    const rows = Object.fromEntries(many(env, 'SELECT email_norm, status, provider_message_id, last_error FROM send_recipients').map((r) => [r.email_norm, r]));
    assert.equal(rows['reader0@example.com'].provider_message_id, 'm-reader0@example.com');
    assert.equal(rows['reader3@example.com'].status, 'failed', 'a rejected address fails without being retried');
    const throttled = requests[2].b.BulkEmailEntries[5].Destination.ToAddresses[0];
    assert.equal(rows[throttled].status, 'queued', 'a throttled person goes back to the queue, not counted as a failure');
    assert.equal(many(env, "SELECT * FROM send_recipients WHERE status = 'sent'").length, n - 2);
    await tick(env);
    assert.equal(rows[throttled] && many(env, 'SELECT status FROM send_recipients WHERE email_norm = ?', throttled)[0].status, 'sent', 'and goes out on the next run');
    assert.equal((await c.get(`/api/admin/sends/${send.data.id}`)).data.status, 'sent');
    // editorial text that happens to contain "{{" is never altered: the send falls back to one request per person
    assert.equal(bulkSafe('<p>Hello {{TOKEN}}</p>'), true);
    assert.equal(bulkSafe('<p>Use {{name}} in a prompt</p>'), false);
  } finally { globalThis.fetch = realFetch; }
});

// ---- signed SNS reports ----

function snsKit() {
  const dir = mkdtempSync(join(tmpdir(), 'sns-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '3650', '-subj', '/CN=sns.amazonaws.com'], { stdio: 'ignore' });
  const key = createPrivateKey(readFileSync(join(dir, 'k.pem'))), cert = readFileSync(join(dir, 'c.pem'), 'utf8');
  const TOPIC = 'arn:aws:sns:us-east-1:111122223333:prompted-ses-events', CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem';
  let seq = 0;
  const signed = (m) => {
    const msg = { MessageId: 'msg-' + (++seq), TopicArn: TOPIC, Timestamp: new Date().toISOString(), SignatureVersion: '1', SigningCertURL: CERT_URL, ...m };
    msg.Signature = rsaSign(msg.SignatureVersion === '2' ? 'sha256' : 'sha1', Buffer.from(stringToSign(msg)), key).toString('base64');
    return msg;
  };
  const note = (event, extra = {}) => signed({ Type: 'Notification', Message: JSON.stringify(event), ...extra });
  return { TOPIC, CERT_URL, cert, signed, note };
}

test('Amazon SES reports through SNS: only correctly signed messages from our topic are accepted, once each; every event type is accounted for', async () => {
  _clearCertCache();
  const kit = snsKit();
  const env = await makeEnv({ SES_TOPIC_ARN: kit.TOPIC }), c = client(env);
  const outside = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    outside.push(String(url));
    if (String(url) === kit.CERT_URL) return new Response(kit.cert);
    if (String(url).startsWith('https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription')) return new Response('<ConfirmSubscriptionResponse/>');
    return new Response('not found', { status: 404 });
  };
  const hook = (m) => c.post('/api/hooks/ses', JSON.stringify(m), { 'content-type': 'text/plain; charset=UTF-8' });
  try {
    // the subscription handshake: confirmed automatically, but only through Amazon and only for our topic
    const confirmUrl = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(kit.TOPIC)}&Token=abc`;
    const sub = kit.signed({ Type: 'SubscriptionConfirmation', Message: 'You have chosen to subscribe', SubscribeURL: confirmUrl, Token: 'abc' });
    assert.equal((await hook({ ...sub, SubscribeURL: 'https://evil.example/x' })).status, 403, 'changing any signed field breaks the signature');
    assert.ok(!outside.includes('https://evil.example/x'));
    const ok = await hook(sub);
    assert.deepEqual([ok.status, ok.data.confirmed], [200, true]);
    assert.ok(outside.includes(confirmUrl));
    assert.equal((await hook(sub)).data.duplicate, true, 'the same message twice is handled once');
    assert.equal(outside.filter((u) => u === confirmUrl).length, 1);

    // forged, foreign, stale or oddly sourced messages are refused before anything changes
    const bounce = (to, subtype = 'General', type = 'Permanent', id = 'mx') => ({ eventType: 'Bounce', mail: { messageId: id, destination: [to] }, bounce: { bounceType: type, bounceSubType: subtype, bouncedRecipients: [{ emailAddress: to, diagnosticCode: 'smtp; 550 5.1.1 user unknown' }] } });
    await c.login();
    for (const e of ['gone@example.com', 'angry@example.com', 'full@example.com', 'checked@example.com', 'listed@example.com', 'late@example.com', 'refused@example.com', 'v2@example.com']) await c.post('/api/admin/people', { email: e, status: 'active', consent_attested: true });
    const forged = kit.note(bounce('angry@example.com')); forged.Message = forged.Message.replace('angry', 'gone');
    assert.equal((await hook(forged)).status, 403);
    assert.equal((await hook(kit.note(bounce('gone@example.com'), { TopicArn: 'arn:aws:sns:us-east-1:999999999999:other' }))).status, 403, 'another topic');
    assert.equal((await hook(kit.note(bounce('gone@example.com'), { Timestamp: new Date(Date.now() - 7 * 3600e3).toISOString() }))).status, 403, 'a replayed old message');
    const before = outside.length;
    assert.equal((await hook(kit.note(bounce('gone@example.com'), { SigningCertURL: 'https://sns.us-east-1.amazonaws.com.evil.example/cert.pem' }))).status, 403);
    assert.equal((await hook(kit.note(bounce('gone@example.com'), { SigningCertURL: 'http://sns.us-east-1.amazonaws.com/cert.pem' }))).status, 403);
    assert.equal(outside.length, before, 'a certificate address that is not Amazon\'s is never fetched');
    assert.equal((await c.post('/api/hooks/ses?key=hook-secret', '{"Type":"Notification"}', { 'content-type': 'text/plain' })).status, 403, 'the old shared key no longer opens the SES address');
    const status = (e) => one(env, 'SELECT status FROM people WHERE email_norm = ?', e).status;
    assert.equal(status('gone@example.com'), 'active', 'nothing changed by refused messages');

    // a sent issue to match reports against
    env.DB.sqlite.exec("INSERT INTO sends (id, issue_slug, kind, status, subject, content_sha256, created_by, created_at) VALUES (900, 'week-of-august-9-16-2026', 'issue', 'sent', 's', 'x', 'test', '2026-11-12T00:00:00Z')");
    for (const e of ['gone', 'angry', 'full', 'checked', 'listed', 'late', 'refused', 'v2']) env.DB.sqlite.prepare("INSERT INTO send_recipients (send_id, person_id, email_norm, token, status, provider, provider_message_id) VALUES (900, (SELECT id FROM people WHERE email_norm = ?), ?, ?, 'sent', 'ses', ?)").run(`${e}@example.com`, `${e}@example.com`, 'tok-' + e, 'id-' + e);
    const r1 = await hook(kit.note(bounce('gone@example.com', 'General', 'Permanent', 'id-gone')));
    assert.deepEqual([r1.status, r1.data.kind, r1.data.handled], [200, 'Bounce', 1]);
    await hook(kit.note({ notificationType: 'Complaint', mail: { messageId: 'id-angry' }, complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'angry@example.com' }] } }));
    await hook(kit.note(bounce('full@example.com', 'MailboxFull', 'Transient', 'id-full')));
    await hook(kit.note(bounce('checked@example.com', 'EmailValidationSuppressed', 'Permanent', 'id-checked')));
    await hook(kit.note({ eventType: 'Complaint', mail: { messageId: 'id-listed' }, complaint: { complaintSubType: 'OnAccountSuppressionList', complainedRecipients: [{ emailAddress: 'listed@example.com' }] } }));
    await hook(kit.note({ eventType: 'DeliveryDelay', mail: { messageId: 'id-late', destination: ['late@example.com'] }, deliveryDelay: { delayType: 'MailboxFull', delayedRecipients: [{ emailAddress: 'late@example.com', diagnosticCode: '452 4.2.2' }] } }));
    await hook(kit.note({ eventType: 'Reject', mail: { messageId: 'id-refused', destination: ['refused@example.com'] }, reject: { reason: 'Bad content' } }));
    const v2 = await hook(kit.note({ eventType: 'Delivery', mail: { messageId: 'id-v2', destination: ['v2@example.com'] }, delivery: { recipients: ['v2@example.com'] } }, { SignatureVersion: '2' }));
    const v2Again = kit.note({ eventType: 'Delivery', mail: { messageId: 'id-v2' }, delivery: { recipients: ['v2@example.com'] } }, { SignatureVersion: '2' });
    assert.equal(v2.status, 200, 'SHA-256 signatures (version 2) are accepted too');
    assert.equal((await hook(kit.note({ eventType: 'Send', mail: { messageId: 'id-v2', destination: ['v2@example.com'], tags: { prompted_send: ['900'] } } }))).data.handled, 1, 'Send becomes an acceptance record');
    for (const k of ['Open', 'Click']) assert.equal((await hook(kit.note({ eventType: k, mail: { messageId: 'id-v2', destination: ['v2@example.com'] } }))).data.handled, 0);
    assert.deepEqual(['gone', 'angry', 'full', 'checked', 'listed', 'late', 'refused', 'v2'].map((e) => status(`${e}@example.com`)),
      ['bounced', 'complained', 'active', 'active', 'active', 'active', 'active', 'active'], 'only real hard bounces and real complaints change a subscriber');
    assert.equal(one(env, "SELECT COUNT(*) n FROM suppressions WHERE email_norm IN ('gone@example.com','angry@example.com')").n, 2);
    const rec = Object.fromEntries(many(env, 'SELECT email_norm, status, last_error FROM send_recipients WHERE send_id = 900').map((r) => [r.email_norm.split('@')[0], r]));
    assert.deepEqual(['gone', 'angry', 'full', 'checked', 'listed', 'late', 'refused', 'v2'].map((e) => rec[e].status), ['bounced', 'complained', 'sent', 'failed', 'failed', 'sent', 'failed', 'delivered']);
    assert.match(rec.checked.last_error, /Auto Validation/);
    assert.match(rec.refused.last_error, /Amazon refused to send this message: Bad content/);
    const types = many(env, "SELECT type FROM delivery_events WHERE provider = 'ses' ORDER BY id").map((r) => r.type);
    assert.deepEqual(types, ['bounce_hard', 'complaint', 'bounce_soft', 'held', 'held', 'delayed', 'not_sent', 'delivered', 'accepted']);
    assert.equal((await hook(v2Again)).status, 200);

    // the dashboard sees that reports are connected and that Amazon is adding tracking
    const rep = JSON.parse(one(env, "SELECT value FROM settings WHERE key = 'ses_reports'").value);
    assert.ok(rep.subscribed_at && rep.tracking_seen_at && !rep.unsubscribed_at);
    await hook(kit.signed({ Type: 'UnsubscribeConfirmation', Message: 'unsubscribed', SubscribeURL: confirmUrl, Token: 'abc' }));
    assert.ok(JSON.parse(one(env, "SELECT value FROM settings WHERE key = 'ses_reports'").value).unsubscribed_at);
    // Brevo's address and secret are unchanged
    assert.equal((await c.post('/api/hooks/brevo', { event: 'hard_bounce', email: 'x@example.com' })).status, 401);
    assert.equal((await c.post('/api/hooks/brevo?key=hook-secret', { event: 'delivered', email: 'x@example.com' })).status, 200);
    // without a configured topic nothing is accepted at all
    delete env.SES_TOPIC_ARN;
    assert.equal((await hook(kit.note(bounce('v2@example.com')))).status, 403);
  } finally { globalThis.fetch = realFetch; }
});

test('Amazon SES status: reads the real account state, names the single next step, and never reports ready while anything is missing', async () => {
  const env = await makeEnv(), c = client(env);
  assert.equal((await c.get('/api/admin/ses/status')).status, 401);
  await c.login();
  assert.equal((await c.get('/api/admin/ses/status')).data.configured, false);
  Object.assign(env, { AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 's', FROM_EMAIL: 'brief@prompted.example' });
  const state = { production: false, verified: true, autoValidation: 'ENABLED', setOverride: null, setExists: true }, calls = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); calls.push((init.method || 'GET') + ' ' + u.pathname);
    const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (u.pathname === '/v2/email/account') return j({ ProductionAccessEnabled: state.production, SendingEnabled: true, EnforcementStatus: 'HEALTHY', VdmAttributes: { VdmEnabled: 'ENABLED', DashboardAttributes: { EngagementMetrics: state.vdmEngagement || 'DISABLED' } }, SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'], ValidationAttributes: { ConditionThreshold: { ConditionThresholdEnabled: state.autoValidation, OverallConfidenceThreshold: { ConfidenceVerdictThreshold: 'MANAGED' } } } }, SendQuota: { Max24HourSend: state.production ? 50000 : 200, MaxSendRate: state.production ? 14 : 1, SentLast24Hours: 0 } });
    if (u.pathname === '/v2/email/identities/prompted.example') return j({ VerifiedForSendingStatus: state.verified, ConfigurationSetName: 'prompted-newsletter', DkimAttributes: { Status: 'SUCCESS' }, MailFromAttributes: { MailFromDomain: 'bounce.prompted.example', MailFromDomainStatus: 'SUCCESS' } });
    if (u.pathname === '/v2/email/configuration-sets/prompted-newsletter') return state.setExists ? j({ ConfigurationSetName: 'prompted-newsletter', SuppressionOptions: state.setOverride ? { ValidationOptions: { ConditionThreshold: { ConditionThresholdEnabled: state.setOverride } } } : {} }) : j({ message: 'not found' }, 404);
    return j({}, 404);
  };
  const st = async () => (await c.get('/api/admin/ses/status')).data;
  try {
    let s = await st();
    assert.deepEqual([s.key_valid, s.production_access, s.quota.per_day, s.used_by_platform, s.ready], [true, false, 200, false, false]);
    assert.match(s.next, /Waiting for Amazon to approve production access/);
    assert.deepEqual(JSON.parse(one(env, "SELECT value FROM settings WHERE key = 'ses_account'").value).max_24h, 200, 'Amazon\'s limits are kept for the sender');
    state.production = true;
    assert.match((await st()).next, /configuration set name/);
    env.SES_CONFIGURATION_SET = 'prompted-newsletter';
    state.setExists = false;
    assert.match((await st()).next, /no configuration set named "prompted-newsletter"/);
    state.setExists = true;
    assert.match((await st()).next, /SES_TOPIC_ARN/);
    env.SES_TOPIC_ARN = 'arn:aws:sns:us-east-1:111122223333:prompted-ses-events';
    s = await st();
    assert.match(s.next, /add an HTTPS subscription on the SNS topic with the address https:\/\/preview\.example\/api\/hooks\/ses/);
    assert.ok(!JSON.stringify(s).includes('hook-secret'), 'the subscription address carries no secret');
    env.DB.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('ses_reports', ?)").run(JSON.stringify({ subscribed_at: '2026-11-12T20:00:00Z' }));
    s = await st();
    assert.deepEqual([s.ready, s.auto_validation.active, s.auto_validation.level], [false, true, 'MANAGED']);
    assert.match(s.next, /Turn off Auto Validation/);
    state.setOverride = 'DISABLED';
    s = await st();
    assert.deepEqual([s.ready, s.auto_validation.active], [true, false], 'the configuration set\'s own setting wins');
    state.setOverride = null; state.autoValidation = 'DISABLED';
    s = await st();
    assert.deepEqual([s.ready, s.used_by_platform, s.platform_daily_limit, s.pace.mode], [true, true, 45000, 'one request per person']);
    assert.equal(s.pace.per_minute, 10);
    assert.ok(s.warnings.some((w) => /Bulk sending is off/.test(w)));
    assert.equal(s.vdm_engagement_tracking, 'DISABLED');
    state.vdmEngagement = 'ENABLED';
    assert.ok((await st()).warnings.some((w) => /VDM engagement tracking is on/.test(w)));
    state.vdmEngagement = 'DISABLED';
    env.SES_BULK = 'on';
    s = await st();
    assert.deepEqual([s.pace.mode, s.pace.per_minute, s.pace.minutes_for['2500']], ['bulk', 56, 45]);
    assert.ok(!calls.some((x) => /outbound/.test(x)), 'reading status sends no email');
  } finally { globalThis.fetch = realFetch; }
});

// ---------- first-party engagement tracking ----------
import { classifyAgent, pruneEngagement, engagementReport } from '../src/worker/engagement.mjs';
import { selectIndexTerms } from '../src/lib/index-terms.mjs';
import { renderIssueEmail as renderEmailForTest } from '../src/lib/render-email.mjs';
import workerForTest from '../src/worker/index.mjs';

const hit = (env, path, { ua = 'Mozilla/5.0 (Macintosh) AppleWebKit Safari', method = 'GET', asn } = {}) => {
  const req = new Request('https://preview.example' + path, { method, headers: { 'user-agent': ua }, redirect: 'manual' });
  if (asn) Object.defineProperty(req, 'cf', { value: { asn } });
  return workerForTest.fetch(req, env);
};

test('tracking is off by default; when on, tracking URLs carry only a random per-send id, template links are tracked, the plain-text part is untouched', async () => {
  const run = async (extra) => {
    const env = await makeEnv({ SEND_MODE: 'live', AUDIENCE_SENDING: 'enabled', SITE_ENV: 'production', EMAIL_PROVIDERS: 'brevo', BREVO_API_KEY: 'k', FROM_EMAIL: 'brief@prompted.example', QUOTA_RESERVE: '0', ...extra });
    const c = await audience(env, 3);
    const bodies = [], realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{"messageId":"m"}', { status: 201 }); };
    try {
      const send = await c.post('/api/admin/sends', { issue_slug: 'week-of-august-9-16-2026' });
      await c.post(`/api/admin/sends/${send.data.id}/approve`);
      await c.post(`/api/admin/sends/${send.data.id}/schedule`, {});
      env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
      await tick(env);
    } finally { globalThis.fetch = realFetch; }
    return { env, bodies };
  };
  const off = await run({});
  assert.ok(off.bodies.length === 3 && off.bodies.every((b) => !/\/r\/|\/o\/|\{\{/.test(b.htmlContent)), 'off by default: no tracking URLs and no leftover placeholders');
  const on = await run({ TRACK_CLICKS: 'true', TRACK_OPENS: 'true' });
  const people = many(on.env, 'SELECT r.email_norm, r.track_id, p.token FROM send_recipients r JOIN people p ON p.id = r.person_id');
  for (const b of on.bodies) {
    const me = people.find((p) => p.email_norm === b.to[0].email), html = b.htmlContent;
    const tracking = [...html.matchAll(/https:\/\/preview\.example\/(r|o)\/([^"'\s<]+)/g)].map((m) => m[0]);
    assert.ok(tracking.length >= 4, 'body, web, Index and forward links plus the image');
    assert.ok(tracking.every((u) => u.includes(`/${me.track_id}`) && /\/(r\/[a-f0-9]{24}\/\d+|o\/[a-f0-9]{24}\.gif)$/.test(u)), 'only the random tracking id');
    assert.equal(html.split(me.token).length - 1, 1, 'the subscriber token appears once: in the unsubscribe link');
    assert.ok(html.includes(`/u/${me.token}`) && b.headers['List-Unsubscribe'] === `<https://preview.example/u/${me.token}>`, 'unsubscribe is never routed through tracking');
    assert.ok(!/\/r\/|\/o\//.test(b.textContent), 'the plain-text part has no tracking');
    assert.ok(!/\{\{/.test(html), 'no placeholder left');
  }
  assert.equal(new Set(people.map((p) => p.track_id)).size, 3, 'a different id for each reader');
  const labels = many(on.env, 'SELECT label, kind FROM send_links ORDER BY idx').map((l) => `${l.kind}:${l.label}`);
  assert.ok(labels.includes('template:Prompted Index (footer)') && labels.includes('template:Read on the web') && labels.some((l) => l.startsWith('body:')));
  assert.ok(!labels.some((l) => l.startsWith('index_term:')), 'the Index block is off unless asked for');
});

test('click links always work and never become an open redirect; recording failures never break a link or the image', async () => {
  const env = await makeEnv(), c = client(env);
  env.DB.sqlite.exec("INSERT INTO sends (id, issue_slug, kind, status, subject, content_sha256, created_by, created_at) VALUES (7, 'week-of-august-9-16-2026', 'issue', 'sent', 's', 'x', 't', '2026-11-12T00:00:00Z')");
  env.DB.sqlite.exec("INSERT INTO send_links (send_id, idx, url, label, kind) VALUES (7, 0, 'https://news.example.org/story', 'the story', 'body'), (7, 1, 'javascript:alert(1)', 'bad', 'body')");
  const TRK = 'a'.repeat(24);
  env.DB.sqlite.exec(`INSERT INTO send_recipients (send_id, email_norm, token, status, track_id, sent_at) VALUES (7, 'r@example.com', '${'b'.repeat(40)}', 'sent', '${TRK}', '2026-11-12T00:00:00Z')`);
  const loc = (r) => r.headers.get('location');
  let r = await hit(env, `/r/${TRK}/0`);
  assert.deepEqual([r.status, loc(r)], [302, 'https://news.example.org/story']);
  assert.equal(loc(await hit(env, `/r/${TRK}/0?url=https://evil.example`)), 'https://news.example.org/story', 'a query string cannot choose the destination');
  assert.equal(loc(await hit(env, `/r/${TRK}/9`)), 'https://preview.example/', 'an unknown link goes home');
  assert.equal(loc(await hit(env, `/r/${'c'.repeat(24)}/0`)), 'https://preview.example/', 'an unknown id goes home');
  assert.equal(loc(await hit(env, `/r/${TRK}/1`)), 'https://preview.example/', 'a stored non-web address is never followed');
  assert.equal((await hit(env, '/r/https%3A%2F%2Fevil.example/0')).status, 404);
  assert.equal(one(env, "SELECT COUNT(*) n FROM engagement_events WHERE kind = 'click'").n, 2, 'only real clicks on real links are recorded');
  // recording fails: link and image still work
  const realBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async () => { throw new Error('D1 is down'); };
  r = await hit(env, `/r/${TRK}/0`);
  assert.deepEqual([r.status, loc(r)], [302, 'https://news.example.org/story']);
  const img = await hit(env, `/o/${TRK}.gif`);
  assert.deepEqual([img.status, img.headers.get('content-type')], [200, 'image/gif']);
  env.DB.batch = realBatch;
  // the database cannot even be read: the reader lands on the archive, not an error
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = () => { throw new Error('D1 is down'); };
  r = await hit(env, `/r/${TRK}/0`);
  assert.deepEqual([r.status, loc(r)], [302, 'https://preview.example/issues/']);
  assert.equal((await hit(env, `/o/${TRK}.gif`)).status, 200);
  env.DB.prepare = realPrepare;
  // links in emails sent before tracking ids still forward, and record nothing
  r = await hit(env, `/r/7/0/${'b'.repeat(40)}`);
  assert.deepEqual([r.status, loc(r)], [302, 'https://news.example.org/story']);
  assert.equal((await hit(env, `/o/7/${'b'.repeat(40)}.gif`)).status, 200);
  assert.equal(one(env, 'SELECT COUNT(*) n FROM engagement_events').n, 2);
  // unsubscribe never depends on tracking
  assert.equal((await c.get('/api/admin/sends/7/engagement')).status, 401, 'reports are private');
});

test('engagement report: raw activity next to an estimate of human activity, per link and per audience group, with no reader identifiers', async () => {
  assert.deepEqual(['browser', 'gmail_proxy', 'scanner', 'scanner', 'head', 'apple_privacy', 'browser', 'microsoft_network'].map((x) => x),
    [classifyAgent(new Request('https://x/', { headers: { 'user-agent': 'Mozilla/5.0 Safari' } }), 'open'),
     classifyAgent(new Request('https://x/', { headers: { 'user-agent': 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)' } }), 'open'),
     classifyAgent(new Request('https://x/', { headers: { 'user-agent': '' } }), 'click'),
     classifyAgent(new Request('https://x/', { headers: { 'user-agent': 'python-requests/2.31' } }), 'click'),
     classifyAgent(new Request('https://x/', { method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0' } }), 'click'),
     (() => { const q = new Request('https://x/', { headers: { 'user-agent': 'Mozilla/5.0' } }); Object.defineProperty(q, 'cf', { value: { asn: 714 } }); return classifyAgent(q, 'open'); })(),
     (() => { const q = new Request('https://x/', { headers: { 'user-agent': 'Mozilla/5.0' } }); Object.defineProperty(q, 'cf', { value: { asn: 714 } }); return classifyAgent(q, 'click'); })(),
     (() => { const q = new Request('https://x/', { headers: { 'user-agent': 'Mozilla/5.0' } }); Object.defineProperty(q, 'cf', { value: { asn: 8075 } }); return classifyAgent(q, 'click'); })()]);

  const env = await makeEnv(), c = client(env);
  await c.login();
  env.DB.sqlite.exec("INSERT INTO sends (id, issue_slug, kind, status, subject, content_sha256, created_by, created_at, started_at) VALUES (5, 'week-of-august-9-16-2026', 'issue', 'sent', 's', 'x', 't', '2026-11-09T13:45:00Z', '2026-11-09T13:45:00Z')");
  env.DB.sqlite.exec("INSERT INTO send_links (send_id, idx, url, label, kind) VALUES (5, 0, 'https://a.example/', 'Story A', 'body'), (5, 1, 'https://b.example/', 'Story B', 'body'), (5, 2, 'https://preview.example/index/#data-center', 'Data center', 'index_term'), (5, 3, 'https://preview.example/index/', 'Prompted Index (footer)', 'template')");
  const people = [...Array.from({ length: 6 }, (_, i) => `m${i}@miamioh.edu`), ...Array.from({ length: 6 }, (_, i) => `g${i}@gmail.com`), 'x0@other.edu', 'x1@other.edu'];
  const ids = {};
  people.forEach((e, i) => {
    env.DB.sqlite.prepare("INSERT INTO people (email, email_norm, status, token, source, created_at, updated_at) VALUES (?, ?, 'active', ?, 'test', '2026-01-01', '2026-01-01')").run(e, e, (i + 10).toString(16).padStart(40, '0'));
    ids[e] = (i + 1).toString(16).padStart(24, '0');
    env.DB.sqlite.prepare("INSERT INTO send_recipients (send_id, person_id, email_norm, token, status, track_id, sent_at) VALUES (5, (SELECT id FROM people WHERE email_norm = ?), ?, 't', 'sent', ?, '2026-11-09T13:45:00Z')").run(e, e, ids[e]);
  });
  for (const e of people.slice(0, 6)) env.DB.sqlite.prepare("INSERT INTO person_tags (person_id, tag) SELECT id, 'sepi-oct' FROM people WHERE email_norm = ?").run(e);
  const ua = { browser: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', gmail: 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)', scan: 'Barracuda Sentinel' };
  // m0: human open + human click on the Index term; m1: a scanner clicks all four links at once; m2: Apple preload only
  await hit(env, `/o/${ids['m0@miamioh.edu']}.gif`, { ua: ua.gmail });
  await hit(env, `/r/${ids['m0@miamioh.edu']}/2`, { ua: ua.browser });
  for (const i of [0, 1, 2, 3]) await hit(env, `/r/${ids['m1@miamioh.edu']}/${i}`, { ua: ua.browser });
  await hit(env, `/o/${ids['m2@miamioh.edu']}.gif`, { ua: 'Mozilla/5.0', asn: 714 });
  await hit(env, `/r/${ids['m3@miamioh.edu']}/0`, { method: 'HEAD', ua: ua.browser });
  await hit(env, `/r/${ids['m4@miamioh.edu']}/1`, { ua: ua.scan });
  // g0: opens twice in a browser and clicks story A; g1: a click arriving within seconds of sending is suspect
  await hit(env, `/o/${ids['g0@gmail.com']}.gif`, { ua: ua.browser });
  await hit(env, `/o/${ids['g0@gmail.com']}.gif`, { ua: ua.browser });
  await hit(env, `/r/${ids['g0@gmail.com']}/0`, { ua: ua.browser });
  env.DB.sqlite.prepare('UPDATE send_recipients SET sent_at = ? WHERE email_norm = ?').run(new Date().toISOString(), 'g1@gmail.com');
  await hit(env, `/r/${ids['g1@gmail.com']}/1`, { ua: ua.browser });
  await hit(env, `/o/${ids['x0@other.edu']}.gif`, { ua: ua.browser });

  const rep = (await c.get('/api/admin/sends/5/engagement')).data;
  assert.equal(rep.sent, 14);
  assert.deepEqual(rep.raw, { opens: 5, unique_opens: 4, open_rate: 28.6, clicks: 9, unique_clicks: 6, click_rate: 42.9 });
  assert.deepEqual(rep.estimated_human, { unique_opens: 3, open_rate: 21.4, clicks: 2, unique_clicks: 2, click_rate: 14.3, click_to_open_rate: 66.7 }, 'm0, g0 and x0 look human; the click implies the open');
  assert.deepEqual(rep.machine_signals, { apple_privacy_opens: 1, scanner_or_checker_events: 2, recipients_with_machine_like_clicks: 4 });
  const link = Object.fromEntries(rep.links.map((l) => [l.label, l]));
  assert.deepEqual([link['Data center'].kind, link['Data center'].raw_clicks, link['Data center'].human_unique], ['index_term', 2, 1], 'per-term clicks, scanner click excluded from the estimate');
  assert.deepEqual([link['Story A'].raw_clicks, link['Story A'].human_unique], [3, 1]);
  const seg = Object.fromEntries(rep.segments.by_address_type.map((s) => [s.segment, s]));
  assert.deepEqual([seg['Miami University addresses'].recipients, seg['Miami University addresses'].human_open_rate, seg['Miami University addresses'].raw_click_rate], [6, 16.7, 66.7]);
  assert.equal(seg['Personal email (Gmail, Outlook, iCloud, Yahoo and similar)'].human_click_rate, 16.7);
  assert.deepEqual(seg['Other university addresses'], { segment: 'Other university addresses', recipients: 'fewer than 5', hidden: true }, 'small groups are not broken out');
  assert.deepEqual(rep.segments.by_tag.map((s) => [s.segment, s.recipients]), [['sepi-oct', 6]]);
  const text = JSON.stringify(rep);
  assert.ok(!people.some((e) => text.includes(e)) && !Object.values(ids).some((t) => text.includes(t)), 'no addresses or tracking ids in reports');
  const trend = (await c.get('/api/admin/engagement/trend')).data;
  assert.deepEqual([trend.rows[0].raw_open_rate, trend.rows[0].human_open_rate], [28.6, 21.4]);

  // retention: old events are summarised, then deleted; the issue's figures survive
  // move everything 400 days into the past, keeping the timing between sending and activity
  env.DB.sqlite.exec("UPDATE engagement_events SET at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(at) - 400)");
  env.DB.sqlite.exec("UPDATE send_recipients SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(sent_at) - 400)");
  env.DB.sqlite.exec("UPDATE sends SET started_at = '2025-01-01T00:00:00Z'");
  await pruneEngagement(env);
  assert.equal(one(env, 'SELECT COUNT(*) n FROM engagement_events').n, 0);
  const kept = await engagementReport(env.DB, 5);
  assert.deepEqual([kept.from_saved_summary, kept.estimated_human.unique_opens, kept.links.length], [true, 3, 4]);
  assert.equal(one(env, 'SELECT SUM(opens) + SUM(clicks) AS n FROM send_recipients').n, 0, 'per-reader counters cleared after the longer limit');
});

test('optional "In the Prompted Index" block: a few distinctive terms, off by default, editorial text untouched, per-term clicks', async () => {
  const idx = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../index/data.json', import.meta.url), 'utf8'));
  const issue = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../content/issues/031-week-of-november-1-8-2026.json', import.meta.url), 'utf8'));
  const terms = selectIndexTerms(issue, idx, 'https://preview.example/index/', 5);
  assert.ok(terms.length >= 1 && terms.length <= 5 && new Set(terms.map((t) => t.term)).size === terms.length);
  assert.ok(terms.every((t) => t.url.startsWith('https://preview.example/index/#')));
  const site = { name: 'Prompted', tagline: 'Your Weekly AI Brief', attribution: 'x', url: 'https://preview.example', asset_base_url: 'https://preview.example', index_url: 'https://preview.example/index/', forward_subscribe_url: 'https://preview.example/s/forward/', postal_address: 'p' };
  const plain = renderEmailForTest(issue, site), withTerms = renderEmailForTest(issue, site, { indexTerms: terms });
  assert.ok(!plain.html.includes('In the Prompted Index') && withTerms.html.includes('In the Prompted Index'));
  const body = (h) => h.slice(h.indexOf('padding:22px 24px 8px 24px;'), h.indexOf('</td></tr>', h.indexOf('padding:22px 24px 8px 24px;')));
  assert.equal(body(withTerms.html), body(plain.html), 'the issue text is byte-for-byte the same');
  assert.ok(withTerms.text.includes('In the Prompted Index:') && withTerms.text.startsWith(plain.text.split('-'.repeat(40))[0].slice(0, 200)));

  // a real send leaves it out unless switched on; test sends can preview it
  const env = await makeEnv({ INDEX_TERMS_EMAIL: 'preview' }), c = client(env);
  await c.login();
  assert.match((await c.get('/api/admin/issues/week-of-november-1-8-2026/email?index_terms=1')).data, /In the Prompted Index/);
  assert.doesNotMatch((await c.get('/api/admin/issues/week-of-november-1-8-2026/email')).data, /In the Prompted Index/, 'preview mode: only on request');
  env.INDEX_TERMS_EMAIL = 'on';
  assert.match((await c.get('/api/admin/issues/week-of-november-1-8-2026/email')).data, /In the Prompted Index/, 'adopted: shown by default');
  assert.doesNotMatch((await c.get('/api/admin/issues/week-of-november-1-8-2026/email?index_terms=0')).data, /In the Prompted Index/);
  env.INDEX_TERMS_EMAIL = 'preview';
  const t = await c.post('/api/admin/sends/test', { issue_slug: 'week-of-november-1-8-2026', emails: ['owner-test@example.com'] });
  assert.ok(t.data.links.some((l) => l.kind === 'index_term'), 'test sends include it in preview mode');
  const s = await c.post('/api/admin/sends', { issue_slug: 'week-of-november-1-8-2026' });
  await c.post(`/api/admin/sends/${s.data.id}/approve`);
  await c.post(`/api/admin/sends/${s.data.id}/schedule`, {});
  env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(s.data.id);
  await tick(env);
  assert.equal(one(env, "SELECT COUNT(*) n FROM send_links WHERE send_id = ? AND kind = 'index_term'", s.data.id).n, 0, 'not in a real send unless INDEX_TERMS_EMAIL is "on"');
});

test('safety fences for real-data staging: audience lock, simulator-only-through-SES, sender guard, inert test unsubscribe', async () => {
  // SEND_MODE live in production but AUDIENCE_SENDING not enabled: the audience still gets the dry-run adapter
  const env = await makeEnv({ SEND_MODE: 'live', SITE_ENV: 'production', EMAIL_PROVIDERS: 'brevo', BREVO_API_KEY: 'k', FROM_EMAIL: 'brief@prompted.example', QUOTA_RESERVE: '0' });
  const c = await audience(env, 4);
  const calls = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return new Response('{"messageId":"m"}', { status: 201 }); };
  try {
    const send = await c.post('/api/admin/sends', { issue_slug: 'week-of-august-9-16-2026' });
    await c.post(`/api/admin/sends/${send.data.id}/approve`);
    await c.post(`/api/admin/sends/${send.data.id}/schedule`, {});
    env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
    await tick(env);
    assert.deepEqual(calls, [], 'no provider contacted');
    assert.deepEqual(many(env, 'SELECT DISTINCT provider FROM send_recipients').map((r) => r.provider), ['dryrun']);
  } finally { globalThis.fetch = realFetch; }
  // simulator addresses: accepted as test recipients on the preview only when SES is the sender
  const env2 = await makeEnv({ BREVO_API_KEY: 'k', FROM_EMAIL: 'brief@prompted.example' }), c2 = client(env2);
  await c2.login();
  assert.equal((await c2.post('/api/admin/sends/test', { issue_slug: 'week-of-august-9-16-2026', emails: ['success@simulator.amazonses.com'] })).status, 409, 'not through Brevo');
  assert.equal((await c2.post('/api/admin/sends/test', { issue_slug: 'week-of-august-9-16-2026', emails: ['someone@example.org'] })).status, 403);
  // the SES adapter refuses any other sender or a missing configuration set, before any request
  const sesEnv = { AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S', FROM_EMAIL: 'brief@prompted.example', SES_CONFIGURATION_SET: 'prompted-newsletter' };
  const msg = { from: { name: 'P', email: 'other@prompted.example' }, to: 'x@example.com', subject: 's', html: 'h', text: 't', headers: {} };
  await assert.rejects(() => ses.send(sesEnv, msg), /sender must be brief@prompted.example/);
  await assert.rejects(() => ses.sendBatch(sesEnv, { ...msg, recipients: [{ to: 'x@example.com', token: 't' }] }), /sender must be/);
  await assert.rejects(() => ses.send({ ...sesEnv, SES_CONFIGURATION_SET: '' }, { ...msg, from: { name: 'P', email: 'brief@prompted.example' } }), /SES_CONFIGURATION_SET/);
  // a test email's inert unsubscribe link changes nothing
  const u = await client(env2).get('/u/test');
  assert.deepEqual([u.status, new URL(u.headers.get('location')).pathname], [303, '/unsubscribed/']);
});

test('someone who unsubscribes, bounces or is suppressed after a send starts is skipped when their turn comes', async () => {
  const env = await makeEnv({ SEND_CHUNK: '3', QUOTA_RESERVE: '0' });
  const c = await audience(env, 8);
  const send = await c.post('/api/admin/sends', { issue_slug: 'week-of-august-9-16-2026' });
  await c.post(`/api/admin/sends/${send.data.id}/approve`);
  await c.post(`/api/admin/sends/${send.data.id}/schedule`, {});
  env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
  await tick(env); // first chunk of 3
  const queued = many(env, "SELECT email_norm FROM send_recipients WHERE status = 'queued' ORDER BY rowid").map((r) => r.email_norm);
  const tok = one(env, 'SELECT token FROM people WHERE email_norm = ?', queued[0]).token;
  await c.post(`/u/${tok}`); // unsubscribes mid-send
  env.DB.sqlite.prepare("INSERT INTO suppressions (email_norm, reason, source, created_at) VALUES (?, 'bounced', 'test', '2026-11-12')").run(queued[1]);
  for (let i = 0; i < 5; i++) await tick(env);
  const st = Object.fromEntries(many(env, 'SELECT email_norm, status FROM send_recipients').map((r) => [r.email_norm, r.status]));
  assert.deepEqual([st[queued[0]], st[queued[1]]], ['skipped', 'skipped']);
  assert.equal(Object.values(st).filter((x) => x === 'sent').length, 6);
  assert.equal(one(env, 'SELECT COUNT(*) n FROM delivery_events WHERE type = ? AND email_norm IN (?, ?)', 'sent', queued[0], queued[1]).n, 0);
});

test('cutover readiness: read-only, lists every blocker, and says NO-GO while anything is missing', async () => {
  const env = await makeEnv(), c = client(env);
  assert.equal((await c.get('/api/admin/cutover/readiness')).status, 401);
  await c.login();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes('dns-query') ? { Status: 0, Answer: [] } : {}), { status: 200 });
  try {
    const r = (await c.get('/api/admin/cutover/readiness')).data;
    assert.equal(r.go, false);
    const names = r.items.map((i) => i.name);
    for (const n of ['Amazon SES production access granted', 'Postal address in the footer', 'Ledger imported from beehiiv within the last 24 hours', 'Inbox placement confirmed by the owner for Miami and personal Gmail from the domain', 'Audience lock (AUDIENCE_SENDING)']) assert.ok(names.includes(n), n);
    assert.ok(r.items.find((i) => i.name === 'Audience lock (AUDIENCE_SENDING)').detail.startsWith('locked'));
    assert.ok(r.items.find((i) => i.name === 'Postal address in the footer').ok, 'the test environment has an address');
  } finally { globalThis.fetch = realFetch; }
});

test('inbound header check: only our test address and our own sender, headers only, verdicts read', async () => {
  const { handleInbound, authVerdicts } = await import('../src/worker/inbound.mjs');
  const env = await makeEnv({ INBOUND_CHECK_ADDRESS: 'seed-check@prompted.example' });
  const msg = (to, from) => { const m = { to, from, rejected: null, headers: new Headers({ 'authentication-results': 'mx.cloudflare.net; spf=pass smtp.mailfrom=bounce.prompted.example; dkim=pass header.d=prompted.example; dmarc=pass header.from=prompted.example', 'list-unsubscribe': '<https://x/u/1>', 'list-unsubscribe-post': 'List-Unsubscribe=One-Click', subject: 'Test', 'x-private': 'never kept' }), setReject(r) { this.rejected = r; } }; return m; };
  const a = msg('other@prompted.example', 'brief@readprompted.org'); await handleInbound(a, env);
  const b = msg('seed-check@prompted.example', 'someone@elsewhere.example'); await handleInbound(b, env);
  assert.ok(a.rejected && b.rejected);
  await handleInbound(msg('seed-check@prompted.example', 'bounce@bounce.readprompted.org'), env);
  const row = one(env, 'SELECT headers FROM inbound_checks');
  const h = JSON.parse(row.headers);
  assert.ok(!('x-private' in h));
  assert.deepEqual(authVerdicts(h), { spf: 'pass', dkim: 'pass', dmarc: 'pass', list_unsubscribe: true, one_click: true });
});

test('an interrupted SES run settles itself: the Amazon Send report marks people sent; silence for an hour re-queues them; never a duplicate', async () => {
  const { sesEvents } = await import('../src/worker/ses.mjs');
  const env = await makeEnv({ SEND_MODE: 'live', SITE_ENV: 'production', AUDIENCE_SENDING: 'enabled', EMAIL_PROVIDERS: 'ses', AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S', FROM_EMAIL: 'brief@prompted.example', SES_CONFIGURATION_SET: 'prompted-newsletter', QUOTA_RESERVE: '0' });
  env.DB.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('ses_account', ?), ('ses_reports', ?)").run(JSON.stringify({ production_access: true, max_24h: 50000, max_rate: 14 }), JSON.stringify({ subscribed_at: '2026-11-13T00:00:00Z' }));
  const c = await audience(env, 3);
  const sent = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); sent.push(b); return new Response(JSON.stringify({ MessageId: 'm-' + sent.length }), { status: 200 }); };
  try {
    const s = await c.post('/api/admin/sends', { issue_slug: 'week-of-august-9-16-2026' });
    await c.post(`/api/admin/sends/${s.data.id}/approve`); await c.post(`/api/admin/sends/${s.data.id}/schedule`, {});
    env.DB.sqlite.prepare("UPDATE sends SET scheduled_at = '2020-01-01T00:00:00Z'").run();
    await tick(env);
    assert.ok(sent.every((b) => b.EmailTags[0].Name === 'prompted_send' && b.EmailTags[0].Value === String(s.data.id)), 'every SES message carries its send');
    // pretend the run stopped after the hand-off: two people left "sending" without a result
    env.DB.sqlite.prepare("UPDATE sends SET status = 'sending' WHERE id = ?").run(s.data.id);
    env.DB.sqlite.prepare("UPDATE send_recipients SET status = 'sending', claimed_at = '2020-01-01T00:00:00Z', provider = 'ses', provider_message_id = NULL WHERE email_norm IN ('reader0@example.com','reader1@example.com')").run();
    // Amazon did accept reader0's message: its signed Send report settles it
    const ev = sesEvents(JSON.stringify({ eventType: 'Send', mail: { messageId: 'm-1', destination: ['reader0@example.com'], tags: { prompted_send: [String(s.data.id)] } } }));
    assert.deepEqual(ev.events.map((e) => [e.type, e.sendId]), [['accepted', s.data.id]]);
    const { applyDeliveryEvents } = await import('../src/worker/index.mjs');
    await applyDeliveryEvents(env, 'ses', ev.events);
    assert.deepEqual({ ...one(env, "SELECT status, provider_message_id FROM send_recipients WHERE email_norm = 'reader0@example.com'") }, { status: 'sent', provider_message_id: 'm-1' });
    const before = sent.length;
    await tick(env);
    const st = Object.fromEntries(many(env, 'SELECT email_norm, status, last_error FROM send_recipients').map((r) => [r.email_norm, r]));
    assert.equal(st['reader0@example.com'].status, 'sent');
    assert.equal(st['reader1@example.com'].status, 'sent', 'no Send report for an hour: Amazon never took it, so it was re-queued and sent');
    assert.equal(sent.length - before, 1, 'exactly one new request: for reader1 only');
  } finally { globalThis.fetch = realFetch; }
});

test('plain delivery check: real provider for an authorised test inbox only, provider can be chosen', async () => {
  const env = await makeEnv({ BREVO_API_KEY: 'k', FROM_EMAIL: 'brief@prompted.example', AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'S', SES_CONFIGURATION_SET: 'prompted-newsletter', SES_USE_IN_SANDBOX: 'true' }), c = client(env);
  env.DB.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('ses_account', ?)").run(JSON.stringify({ production_access: false, max_24h: 200, max_rate: 1 }));
  await c.login();
  const hosts = [], realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => { hosts.push(new URL(url).host); bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ MessageId: 'm', messageId: 'b' }), { status: 200 }); };
  try {
    assert.equal((await c.post('/api/admin/sends/diagnostic', { email: 'stranger@example.com' })).status, 403);
    const a = (await c.post('/api/admin/sends/diagnostic', { email: 'owner-test@example.com' })).data;
    const b = (await c.post('/api/admin/sends/diagnostic', { email: 'owner-test@example.com', provider: 'brevo' })).data;
    assert.deepEqual([a.ok, a.provider, b.ok, b.provider], [true, 'ses', true, 'brevo']);
    assert.deepEqual(hosts, ['email.us-east-1.amazonaws.com', 'api.brevo.com']);
    assert.ok(!('headers' in bodies[1]), 'no empty headers object is sent to Brevo (it rejects one)');
  } finally { globalThis.fetch = realFetch; }
});
