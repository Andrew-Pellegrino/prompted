// End-to-end tests of the Worker against an in-memory database. Synthetic identities only.
import test from 'node:test';
import { awsSign, ses, readSesNotification } from '../src/worker/ses.mjs';
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
  const r = one(env, 'SELECT token FROM send_recipients LIMIT 1');
  assert.equal((await c.get(`/o/${send.data.id}/${r.token}.gif`)).headers.get('content-type'), 'image/gif');
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
    const live = await makeEnv({ SEND_MODE: 'live', BREVO_API_KEY: 'k', FROM_EMAIL: 'brief@prompted.example', REPLY_TO: 'owner@example.com' });
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
  const env = await makeEnv({ SEND_MODE: 'live', EMAIL_PROVIDERS: 'gmail', GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'cs', GMAIL_REFRESH_TOKEN: 'rt', GMAIL_FROM_EMAIL: 'sender@gmail.test', SITE_ENV: 'production', SEND_CHUNK: '10' });
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
    assert.deepEqual([t.data.recipients.sent, t.data.providers, t.data.links.length], [1, ['gmail'], 1], 'four links in the issue, one distinct address');
    const mime = sent[1], html = Buffer.from(mime.split('Content-Transfer-Encoding: base64\r\n\r\n')[2].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString();
    assert.ok(mime.includes(`List-Unsubscribe: <https://preview.example/u/${person.token}>`) && mime.includes('List-Unsubscribe-Post: List-Unsubscribe=One-Click'));
    assert.ok(html.includes(`https://preview.example/u/${person.token}`) && html.includes(`/r/${t.data.id}/0/${person.token}`) && html.includes(`/o/${t.data.id}/${person.token}.gif`));
    assert.ok(mime.startsWith('From: Prompted <sender@gmail.test>\r\nTo: <owner-test@example.com>\r\nSubject: =?UTF-8?B?'));
    // a tracked link forwards to the original address and is counted; unsubscribe really unsubscribes
    const click = await c.get(`/r/${t.data.id}/0/${person.token}`);
    assert.equal(click.status, 302);
    assert.equal(click.headers.get('location'), new URL(one(env, 'SELECT url FROM send_links WHERE send_id = ? AND idx = 0', t.data.id).url).href);
    await c.get(`/o/${t.data.id}/${person.token}.gif`);
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
  const env = await makeEnv({ SEND_MODE: 'live', SITE_ENV: 'production', EMAIL_PROVIDERS: 'brevo', BREVO_API_KEY: 'k', FROM_EMAIL: 'brief@prompted.example', WARMUP: `${start},5,1.5`, SEND_CHUNK: '50' });
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

test('Amazon SES: request signing matches the published AWS example; the adapter sends one message with unsubscribe headers', async () => {
  // The "get-vanilla" case from the AWS Signature Version 4 test suite.
  const signed = await awsSign({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service', method: 'GET', host: 'example.amazonaws.com', path: '/', at: new Date('2015-08-30T12:36:00Z') });
  assert.equal(signed['x-amz-date'], '20150830T123600Z');
  assert.equal(signed.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');

  const env = { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', SES_REGION: 'us-east-2', FROM_EMAIL: 'brief@prompted.example', SES_CONFIGURATION_SET: 'prompted' };
  assert.equal(ses.configured({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }), false, 'keys without a sender address are not ready');
  assert.deepEqual([ses.configured(env), ses.dailyLimit(env), ses.dailyLimit({ SES_DAILY_LIMIT: '45000' })], [true, 190, 45000]);
  assert.deepEqual(providerChain({ ...env, SEND_MODE: 'live', BREVO_API_KEY: 'k' }).map((p) => p.name), ['ses', 'brevo'], 'SES first, Brevo as fallback');
  const calls = [], realFetch = globalThis.fetch;
  let answer = () => new Response(JSON.stringify({ MessageId: 'ses-1' }), { status: 200 });
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return answer(); };
  try {
    const msg = { from: { name: 'Prompted', email: 'brief@prompted.example' }, replyTo: null, to: 'reader@example.com', subject: 'Prompted | Week of November 1–8', html: '<p>hi</p>', text: 'hi', headers: { 'List-Unsubscribe': '<https://x/u/1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
    assert.deepEqual(await ses.send(env, msg), { ok: true, id: 'ses-1' });
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(calls[0].url, 'https://email.us-east-2.amazonaws.com/v2/email/outbound-emails');
    assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-2\/ses\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(calls[0]).includes('"secret"'), 'the secret key is never sent');
    assert.deepEqual([sent.FromEmailAddress, sent.Destination.ToAddresses, sent.ConfigurationSetName, sent.Content.Simple.Subject.Data], ['"Prompted" <brief@prompted.example>', ['reader@example.com'], 'prompted', msg.subject]);
    assert.deepEqual(sent.Content.Simple.Headers, [{ Name: 'List-Unsubscribe', Value: '<https://x/u/1>' }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }]);
    assert.deepEqual([sent.Content.Simple.Body.Html.Data, sent.Content.Simple.Body.Text.Data], ['<p>hi</p>', 'hi']);
    await assert.rejects(() => ses.send(env, { ...msg, subject: 'x\r\nBcc: evil@example.com' }), /Header injection/);
    answer = () => new Response(JSON.stringify({ message: 'Maximum sending rate exceeded.' }), { status: 429, headers: { 'x-amzn-errortype': 'TooManyRequestsException' } });
    assert.equal((await ses.send(env, msg)).rateLimited, true, 'a rate limit pauses the send instead of failing people');
    answer = () => new Response(JSON.stringify({ message: 'The security token included in the request is invalid.' }), { status: 403, headers: { 'x-amzn-errortype': 'UnrecognizedClientException' } });
    assert.equal((await ses.send(env, msg)).authError, true);
    answer = () => new Response(JSON.stringify({ message: 'Email address is not verified.' }), { status: 400, headers: { 'x-amzn-errortype': 'MessageRejected' } });
    const rejected = await ses.send(env, msg);
    assert.deepEqual([rejected.ok, rejected.retryable, !!rejected.rateLimited], [false, false, false]);
  } finally { globalThis.fetch = realFetch; }
});

test('Amazon SES reports: status endpoint names the next step; bounces and complaints suppress people; the handshake only calls Amazon', async () => {
  const env = await makeEnv(), c = client(env);
  assert.equal((await c.get('/api/admin/ses/status')).status, 401);
  await c.login();
  assert.equal((await c.get('/api/admin/ses/status')).data.configured, false);
  Object.assign(env, { AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 's', FROM_EMAIL: 'brief@prompted.example' });
  const state = { production: false, verified: false }, calls = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); calls.push((init.method || 'GET') + ' ' + u.host + u.pathname);
    const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (u.pathname === '/v2/email/configuration-sets/prompted') return j({ ConfigurationSetName: 'prompted', SuppressionOptions: state.setOverride ? { ValidationOptions: { ConditionThreshold: { ConditionThresholdEnabled: state.setOverride } } } : {} });
    if (u.pathname === '/v2/email/account') return j({ ProductionAccessEnabled: state.production, SendingEnabled: true, EnforcementStatus: 'HEALTHY', SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'], ValidationAttributes: state.autoValidation ? { ConditionThreshold: { ConditionThresholdEnabled: 'ENABLED', OverallConfidenceThreshold: { ConfidenceVerdictThreshold: 'MANAGED' } } } : { ConditionThreshold: { ConditionThresholdEnabled: 'DISABLED' } } }, SendQuota: { Max24HourSend: state.production ? 50000 : 200, MaxSendRate: state.production ? 14 : 1, SentLast24Hours: 0 } });
    if (u.pathname === '/v2/email/identities/prompted.example') return j({ VerifiedForSendingStatus: state.verified, DkimAttributes: { Status: state.verified ? 'SUCCESS' : 'PENDING' }, MailFromAttributes: { MailFromDomain: 'bounce.prompted.example', MailFromDomainStatus: 'SUCCESS' } });
    if (u.host === 'sns.us-east-1.amazonaws.com') return new Response('<ok/>');
    return j({}, 404);
  };
  try {
    let st = (await c.get('/api/admin/ses/status')).data;
    assert.deepEqual([st.key_valid, st.domain.verified, st.production_access, st.quota.per_day], [true, false, false, 200]);
    assert.match(st.next, /Waiting for Amazon to see the DKIM records/);
    state.verified = true;
    assert.match((await c.get('/api/admin/ses/status')).data.next, /Request production access/);
    state.production = true;
    assert.match((await c.get('/api/admin/ses/status')).data.next, /bounce and complaint reports/);
    env.SES_CONFIGURATION_SET = 'prompted';
    st = (await c.get('/api/admin/ses/status')).data;
    assert.deepEqual([st.ready, st.quota.per_day, st.quota.per_second, st.auto_validation.active], [true, 50000, 14, false]);
    // Auto Validation switched on at Amazon: not ready, and the panel says what to do
    state.autoValidation = true;
    st = (await c.get('/api/admin/ses/status')).data;
    assert.deepEqual([st.ready, st.auto_validation.active, st.auto_validation.level], [false, true, 'MANAGED']);
    assert.match(st.next, /Turn off Auto Validation/);
    state.setOverride = 'DISABLED'; // the configuration set we send with overrides the account setting
    st = (await c.get('/api/admin/ses/status')).data;
    assert.deepEqual([st.ready, st.auto_validation.active, st.auto_validation.account.enabled], [true, false, true]);
    state.autoValidation = false; state.setOverride = null;
    assert.ok(!calls.some((x) => x.includes('outbound-emails')), 'reading status sends no email');

    // reports arrive through Amazon's notification service
    const hook = (payload, key = 'hook-secret') => c.post('/api/hooks/ses?key=' + key, JSON.stringify(payload), { 'content-type': 'text/plain; charset=UTF-8' });
    assert.equal((await hook({ Type: 'Notification', Message: '{}' }, 'wrong')).status, 401);
    const before = calls.length;
    assert.equal((await hook({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://evil.example/steal' })).status, 400);
    assert.equal((await hook({ Type: 'SubscriptionConfirmation', SubscribeURL: 'http://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription' })).status, 400);
    assert.equal(calls.length, before, 'a confirmation address that is not Amazon is never called');
    assert.equal((await hook({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t' })).data.confirmed, true);
    assert.equal(calls.at(-1), 'GET sns.us-east-1.amazonaws.com/');

    await c.post('/api/admin/people', { email: 'gone@example.com', status: 'active', consent_attested: true });
    await c.post('/api/admin/people', { email: 'angry@example.com', status: 'active', consent_attested: true });
    await c.post('/api/admin/people', { email: 'full@example.com', status: 'active', consent_attested: true });
    const note = (m) => hook({ Type: 'Notification', Message: JSON.stringify(m) });
    assert.equal((await note({ eventType: 'Bounce', mail: { messageId: 'm1' }, bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'Gone <gone@example.com>', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }] } })).data.handled, 1);
    await note({ eventType: 'Bounce', mail: { messageId: 'm2' }, bounce: { bounceType: 'Transient', bounceSubType: 'MailboxFull', bouncedRecipients: [{ emailAddress: 'full@example.com' }] } });
    await note({ notificationType: 'Complaint', mail: { messageId: 'm3' }, complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'angry@example.com' }] } });
    const status = (e) => one(env, 'SELECT status FROM people WHERE email_norm = ?', e).status;
    assert.deepEqual([status('gone@example.com'), status('full@example.com'), status('angry@example.com')], ['bounced', 'active', 'complained'], 'a full mailbox is not a reason to drop someone');
    assert.equal(one(env, "SELECT COUNT(*) n FROM suppressions WHERE email_norm IN ('gone@example.com','angry@example.com')").n, 2, 'both can never be mailed again');
    assert.match(one(env, "SELECT detail FROM delivery_events WHERE email_norm = 'gone@example.com' AND type = 'bounce_hard'").detail, /user unknown/);
    // Amazon chose not to send (its address check, or its own suppression list). That is not a bounce:
    // the message is marked not delivered and the subscriber is left exactly as they were.
    for (const e of ['checked@example.com', 'listed@example.com', 'earlier@example.com']) await c.post('/api/admin/people', { email: e, status: 'active', consent_attested: true });
    env.DB.sqlite.exec("INSERT INTO sends (id, issue_slug, kind, status, subject, content_sha256, created_by, created_at) VALUES (900, 'week-of-august-9-16-2026', 'issue', 'sent', 's', 'x', 'test', '2026-11-12T00:00:00Z')");
    for (const [e, id] of [['checked@example.com', 'h1'], ['listed@example.com', 'h2'], ['earlier@example.com', 'h3']]) env.DB.sqlite.prepare("INSERT INTO send_recipients (send_id, person_id, email_norm, token, status, provider, provider_message_id) VALUES (900, (SELECT id FROM people WHERE email_norm = ?), ?, ?, 'sent', 'ses', ?)").run(e, e, 'tok-' + id, id);
    assert.equal((await note({ eventType: 'Bounce', mail: { messageId: 'h1' }, bounce: { bounceType: 'Permanent', bounceSubType: 'EmailValidationSuppressed', bouncedRecipients: [{ emailAddress: 'checked@example.com' }] } })).data.handled, 1);
    await note({ eventType: 'Bounce', mail: { messageId: 'h2' }, bounce: { bounceType: 'Permanent', bounceSubType: 'OnAccountSuppressionList', bouncedRecipients: [{ emailAddress: 'listed@example.com' }] } });
    await note({ eventType: 'Complaint', mail: { messageId: 'h3' }, complaint: { complaintSubType: 'OnAccountSuppressionList', complainedRecipients: [{ emailAddress: 'earlier@example.com' }] } });
    assert.deepEqual(['checked@example.com', 'listed@example.com', 'earlier@example.com'].map(status), ['active', 'active', 'active'], 'a hold by Amazon never unsubscribes or suppresses anyone');
    assert.equal(one(env, "SELECT COUNT(*) n FROM suppressions WHERE email_norm IN ('checked@example.com','listed@example.com','earlier@example.com')").n, 0);
    const heldRows = many(env, "SELECT email_norm, status, last_error FROM send_recipients WHERE send_id = 900 ORDER BY email_norm");
    assert.deepEqual(heldRows.map((r) => r.status), ['failed', 'failed', 'failed'], 'but the message is shown as not delivered');
    assert.match(heldRows[0].last_error, /Auto Validation/);
    assert.equal(one(env, "SELECT COUNT(*) n FROM delivery_events WHERE type = 'held' AND provider = 'ses'").n, 3);
    env.SES_TOPIC_ARN = 'arn:aws:sns:us-east-1:111122223333:prompted';
    assert.equal((await hook({ Type: 'Notification', TopicArn: 'arn:aws:sns:us-east-1:999:other', Message: '{}' })).status, 400, 'reports from another topic are refused once the topic is pinned');
  } finally { globalThis.fetch = realFetch; }
});
