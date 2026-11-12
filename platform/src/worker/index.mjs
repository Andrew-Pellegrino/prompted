// Prompted Worker: static site (ASSETS) + public API + authenticated admin API + cron sender.
import { json, fail, HttpError, all, first, run, now, hmac, safeEqual, verifyPassword, rateLimited, pruneRateLimits, audit, clientIp, siteConfig, listIssues, loadIssue } from './core.mjs';
import { subscribe, confirm, unsubscribe, setStatus, createPerson, updatePerson, getPerson, listPeople, peopleQuery, PEOPLE_COLUMNS, STATUSES, normalizeEmail, suppress } from './people.mjs';
import { planImport, commitImport, reconcile } from './imports.mjs';
import { sendTransactional } from './sending.mjs';
import { checkDomain } from './dnscheck.mjs';
import { brevoStatus, brevoSetup } from './brevo.mjs';
import { sesStatus, sesEvents, refreshSesAccount } from './ses.mjs';
import { verifySnsMessage, isAmazonSnsUrl } from './sns.mjs';
import { prepareSend, getSend, approveSend, scheduleSend, cancelSend, testSend, tick, retryFailed, extendSend, sendConfirmation, quotas, withMailSettings, checkGmailHealth } from './sending.mjs';
import { dashboard, importBeehiivMetrics, importGrowth, fullBackup, restoreBackup } from './analytics.mjs';
import { toCsv } from '../lib/csv.mjs';
import { runQA } from '../lib/qa.mjs';
import { importIssueText } from '../lib/import-text.mjs';
import { blocksText } from '../lib/issue-model.mjs';
import { sha256 } from './core.mjs';
import { renderIssueEmail, fillRecipient } from '../lib/render-email.mjs';
import { esc } from '../lib/html.mjs';

const SESSION_HOURS = 12;
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
const page = (title, body, status = 200) => new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} — Prompted</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&display=swap" rel="stylesheet"><link rel="stylesheet" href="/assets/styles.css"><link rel="icon" type="image/svg+xml" href="/favicon.svg"></head>
<body>
<div class="nav"><div class="wrap"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="26" height="26">Prompted</a><nav aria-label="Main"><a href="/issues/">Archive</a><a href="/index/">Index</a></nav></div></div>
<main id="main"><div class="wrap"><div class="prose action"><h1>${esc(title)}</h1>${body}</div></div></main>
<footer class="site"><div class="wrap"><p>Prompted. Your Weekly AI Brief.</p><nav aria-label="Footer"><a href="/issues/">Archive</a><a href="/privacy/">Privacy</a></nav></div></footer>
</body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const body = async (request, max = 6_000_000) => {
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, 'Request is too large.');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Request body must be JSON.'); }
};

// ---------- sessions ----------
async function sessionCookie(env, actor) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000, payload = `${actor}.${exp}`;
  return `prompted_admin=${payload}.${await hmac(env.SESSION_SECRET, payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;
}
async function sessionActor(env, request) {
  if (!env.SESSION_SECRET) return null;
  const m = /(?:^|;\s*)prompted_admin=([^;]+)/.exec(request.headers.get('cookie') || '');
  if (!m) return null;
  const parts = m[1].split('.'), sig = parts.pop(), payload = parts.join('.');
  if (!safeEqual(sig, await hmac(env.SESSION_SECRET, payload))) return null;
  const exp = Number(parts.pop());
  return exp > Date.now() ? parts.join('.') : null;
}
// Mutating admin requests must come from our own pages (defence in depth on top of SameSite=Strict).
const sameOrigin = (request) => { const o = request.headers.get('origin'); return !o || o === new URL(request.url).origin; };

// ---------- public API ----------
async function apiSubscribe(request, env) {
  const db = env.DB, ip = clientIp(request);
  const ct = request.headers.get('content-type') || '';
  const input = ct.includes('json') ? await body(request, 20_000) : Object.fromEntries(await request.formData());
  const generic = { ok: true, message: env.DOUBLE_OPT_IN === 'false' ? 'Thanks. You are subscribed.' : 'Almost done. Check your inbox and confirm your subscription.' };
  // Bots: honeypot field filled, or the form was submitted implausibly fast. Answer as if it worked.
  if (input.website || (input.elapsed_ms !== undefined && Number(input.elapsed_ms) < 1200)) return json(generic);
  if (await rateLimited(db, `sub:ip:${ip}`, Number(env.SIGNUP_LIMIT_PER_HOUR || 8), 3600)) return fail(429, 'Too many attempts. Please try again later.');
  if (await rateLimited(db, 'sub:global', Number(env.SIGNUP_GLOBAL_LIMIT_PER_HOUR || 200), 3600)) return fail(429, 'Sign-ups are briefly paused. Please try again later.');
  const { person, action } = await subscribe(db, input, { doubleOptIn: env.DOUBLE_OPT_IN !== 'false' });
  let confirmUrl;
  if (person && ['created', 'resend_confirmation', 'resubscribe_requested'].includes(action)) {
    // At most 3 confirmation emails per address per day, so the form cannot be used to mail-bomb anyone.
    if (!(await rateLimited(db, `sub:mail:${person.email_norm}`, 3, 86400))) await sendConfirmation(env, person);
    if (env.EXPOSE_CONFIRM_LINKS === 'true' && env.SITE_ENV !== 'production') confirmUrl = `/confirm/${person.token}`; // local testing only
  }
  if (!ct.includes('json')) return Response.redirect(new URL('/subscribe/?submitted=1', request.url), 303);
  return json(confirmUrl ? { ...generic, dev_confirm_url: confirmUrl } : generic); // same answer for every outcome: no address enumeration
}

async function confirmRoute(request, env, token) {
  const db = env.DB;
  if (request.method === 'GET') {
    const person = await first(db, 'SELECT status FROM people WHERE token = ?', token);
    if (!person) return page('Link not recognised', '<p>This confirmation link is not valid. You can <a href="/subscribe/">subscribe again</a>.</p>', 404);
    if (person.status === 'active') return Response.redirect(new URL('/subscribe/confirmed/', request.url), 303);
    // A button (POST) rather than confirming on GET, so mail scanners that pre-fetch links cannot confirm for someone.
    return page('Confirm your subscription', `<p>One click and you are in. Prompted is free and arrives once a week.</p><form method="post"><button class="btn big" type="submit">Yes, subscribe me to Prompted</button></form><p class="fine">If you did not ask to subscribe, just close this page. Nothing will be sent.</p>`);
  }
  const person = await confirm(db, token);
  if (!person || person.status !== 'active') return page('We could not confirm this address', '<p>Please contact us by replying to any Prompted email.</p>', 409);
  return Response.redirect(new URL('/subscribe/confirmed/', request.url), 303);
}

async function unsubscribeRoute(request, env, token) {
  const db = env.DB;
  if (request.method === 'GET') {
    const person = await first(db, 'SELECT status FROM people WHERE token = ?', token);
    if (!person) return page('Link not recognised', '<p>This unsubscribe link is not valid.</p>', 404);
    if (person.status === 'unsubscribed') return Response.redirect(new URL('/unsubscribed/', request.url), 303);
    return page('Unsubscribe from Prompted?', `<p>You will stop receiving the weekly brief straight away.</p><form method="post"><button class="btn big" type="submit">Unsubscribe</button></form><p class="fine">Changed your mind? Close this page and nothing changes.</p>`);
  }
  // POST covers both the button above and RFC 8058 one-click unsubscribe from mail clients.
  const person = await unsubscribe(db, token);
  if (!person) return page('Link not recognised', '<p>This unsubscribe link is not valid.</p>', 404);
  const last = await first(db, "SELECT send_id FROM send_recipients WHERE person_id = ? AND status IN ('sent','delivered') ORDER BY send_id DESC LIMIT 1", person.id);
  await run(db, "INSERT INTO delivery_events (send_id, email_norm, type, provider, at) VALUES (?, ?, 'unsubscribe', 'platform', ?)", last?.send_id ?? null, person.email_norm, now());
  return Response.redirect(new URL('/unsubscribed/', request.url), 303);
}

async function openRoute(env, sendId, token) {
  if (token !== 'test') await run(env.DB, 'UPDATE send_recipients SET opens = opens + 1, first_opened_at = COALESCE(first_opened_at, ?) WHERE send_id = ? AND token = ?', now(), sendId, token);
  return new Response(GIF, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, private' } });
}
async function clickRoute(env, sendId, idx, token) {
  const link = await first(env.DB, 'SELECT url FROM send_links WHERE send_id = ? AND idx = ?', sendId, idx);
  if (!link) return Response.redirect((await siteConfig(env)).url + '/', 302);
  await env.DB.batch([
    env.DB.prepare('UPDATE send_links SET clicks = clicks + 1 WHERE send_id = ? AND idx = ?').bind(sendId, idx),
    env.DB.prepare('UPDATE send_recipients SET clicks = clicks + 1, first_clicked_at = COALESCE(first_clicked_at, ?) WHERE send_id = ? AND token = ?').bind(now(), sendId, token),
  ]);
  return Response.redirect(link.url, 302); // only ever to a URL stored from the approved issue: not an open redirect
}

// Provider webhooks (delivery, bounce, complaint). Authenticated by a shared secret in the URL.
const HOOK_TYPES = {
  brevo: { delivered: 'delivered', hard_bounce: 'bounce_hard', invalid_email: 'bounce_hard', blocked: 'bounce_hard', soft_bounce: 'bounce_soft', spam: 'complaint', complaint: 'complaint', unsubscribed: 'unsubscribe' },
  resend: { 'email.delivered': 'delivered', 'email.bounced': 'bounce_hard', 'email.complained': 'complaint', 'email.delivery_delayed': 'bounce_soft' },
};
async function webhookRoute(request, env, provider) {
  // Amazon SES reports arrive through Amazon SNS and are proven by Amazon's signature, so that address
  // carries no secret. Brevo and Resend keep the shared secret in the URL, exactly as before.
  if (provider === 'ses') return sesHook(request, env);
  if (!env.WEBHOOK_SECRET || !safeEqual(new URL(request.url).searchParams.get('key') || '', env.WEBHOOK_SECRET)) return fail(401, 'Bad webhook key.');
  if (!HOOK_TYPES[provider]) return fail(404, 'Unknown provider.');
  const payload = await body(request, 200_000);
  const events = (Array.isArray(payload) ? payload : [payload]).map((ev) => provider === 'brevo'
    ? { type: HOOK_TYPES.brevo[ev.event], email: ev.email, msgId: ev['message-id'], reason: ev.reason }
    : { type: HOOK_TYPES.resend[ev.type], email: ev.data?.to?.[0], msgId: ev.data?.email_id, reason: ev.data?.bounce?.message });
  return json({ ok: true, handled: await applyDeliveryEvents(env, provider, events.slice(0, 20)) });
}

const sesReports = async (env) => JSON.parse((await first(env.DB, "SELECT value FROM settings WHERE key = 'ses_reports'"))?.value || '{}');
const saveSesReports = (env, v) => run(env.DB, "INSERT INTO settings (key, value) VALUES ('ses_reports', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(v));

async function sesHook(request, env) {
  if (request.method !== 'POST') return fail(405, 'POST only.');
  if (await rateLimited(env.DB, 'hook:ses:' + clientIp(request), 600, 60)) return fail(429, 'Too many requests.');
  const m = await body(request, 300_000);
  const v = await verifySnsMessage(m, { topicArn: env.SES_TOPIC_ARN });
  if (!v.ok) {
    // A temporary problem fetching Amazon's certificate: answer 503 so SNS tries again later.
    if (v.retry) return fail(503, 'Could not check the signature yet.');
    await audit(env.DB, 'webhook:ses', 'ses.report_refused', null, null, { reason: v.reason });
    return fail(403, 'Refused.');
  }
  // Each SNS message is handled once, however often it is delivered.
  if (await first(env.DB, "SELECT 1 AS x FROM webhook_messages WHERE provider = 'ses' AND message_id = ?", m.MessageId)) return json({ ok: true, duplicate: true });
  const remember = (kind) => run(env.DB, "INSERT OR IGNORE INTO webhook_messages (provider, message_id, kind, received_at) VALUES ('ses', ?, ?, ?)", m.MessageId, kind, now());

  if (m.Type === 'SubscriptionConfirmation') {
    const u = isAmazonSnsUrl(m.SubscribeURL) ? new URL(m.SubscribeURL) : null;
    if (!u || u.searchParams.get('Action') !== 'ConfirmSubscription' || u.searchParams.get('TopicArn') !== env.SES_TOPIC_ARN) return fail(403, 'Refused.');
    const r = await fetch(u.href, { redirect: 'manual' });
    if (!r.ok) return fail(502, 'Amazon did not accept the confirmation; SNS will retry.');
    await remember('SubscriptionConfirmation');
    await saveSesReports(env, { ...(await sesReports(env)), subscribed_at: now(), unsubscribed_at: null });
    await audit(env.DB, 'webhook:ses', 'ses.reports_connected', null, null, null);
    return json({ ok: true, confirmed: true });
  }
  if (m.Type === 'UnsubscribeConfirmation') {
    // Someone removed the subscription in AWS. Record it and do not resubscribe on our own.
    await remember('UnsubscribeConfirmation');
    await saveSesReports(env, { ...(await sesReports(env)), unsubscribed_at: now() });
    await audit(env.DB, 'webhook:ses', 'ses.reports_disconnected', null, null, null);
    return json({ ok: true });
  }
  const parsed = sesEvents(m.Message);
  await remember(parsed.kind);
  try {
    if (parsed.tracking) {
      const rep = await sesReports(env);
      if (!rep.tracking_seen_at) await saveSesReports(env, { ...rep, tracking_seen_at: now() });
    }
    const handled = await applyDeliveryEvents(env, 'ses', parsed.events.slice(0, 60));
    return json({ ok: true, kind: parsed.kind, handled });
  } catch (e) {
    // Let SNS deliver it again rather than lose a bounce or complaint.
    await run(env.DB, "DELETE FROM webhook_messages WHERE provider = 'ses' AND message_id = ?", m.MessageId);
    throw e;
  }
}

/**
 * One vocabulary for every provider's reports:
 *   delivered    the receiving mail server accepted it (not proof of the inbox)
 *   bounce_hard  the address does not work: the person is marked bounced and suppressed for good
 *   complaint    the person marked it as spam: marked complained and suppressed for good
 *   unsubscribe  the person left through the provider: unsubscribed and suppressed
 *   held         the provider chose not to send (its own guess or its own list): message marked not
 *                delivered, the person is NOT changed
 *   not_sent     the provider refused or could not build the message: marked not delivered, person unchanged
 *   bounce_soft, delayed   temporary: recorded only
 */
async function applyDeliveryEvents(env, provider, events) {
  let handled = 0;
  for (const ev of events) {
    const type = ev.type, msgId = ev.msgId;
    const email = normalizeEmail((/<([^<>]+)>/.exec(String(ev.email || '')) || [])[1] || ev.email);
    if (!type || !email) continue;
    const rec = (msgId && await first(env.DB, 'SELECT send_id, person_id FROM send_recipients WHERE provider_message_id = ? AND email_norm = ?', msgId, email))
      || await first(env.DB, 'SELECT send_id, person_id FROM send_recipients WHERE email_norm = ? ORDER BY send_id DESC LIMIT 1', email);
    const reason = String(ev.reason || '').slice(0, 300) || null;
    await run(env.DB, 'INSERT INTO delivery_events (send_id, email_norm, type, provider, detail, at) VALUES (?, ?, ?, ?, ?, ?)', rec?.send_id ?? null, email, type, provider, reason, now());
    if (rec && type === 'delivered') await run(env.DB, "UPDATE send_recipients SET status = 'delivered', delivered_at = ? WHERE send_id = ? AND email_norm = ? AND status = 'sent'", now(), rec.send_id, email);
    if (rec && (type === 'held' || type === 'not_sent')) await run(env.DB, "UPDATE send_recipients SET status = 'failed', last_error = ? WHERE send_id = ? AND email_norm = ? AND status IN ('sent','delivered')", reason || 'not sent by the provider', rec.send_id, email);
    if (type === 'bounce_hard' || type === 'complaint' || type === 'unsubscribe') {
      const to = type === 'bounce_hard' ? 'bounced' : type === 'complaint' ? 'complained' : 'unsubscribed';
      if (rec && to !== 'unsubscribed') await run(env.DB, 'UPDATE send_recipients SET status = ? WHERE send_id = ? AND email_norm = ?', to, rec.send_id, email);
      const person = await first(env.DB, 'SELECT * FROM people WHERE email_norm = ?', email);
      if (person) await setStatus(env.DB, person, to, { reason: `${provider} reported ${type}`, actor: `webhook:${provider}` });
      else await suppress(env.DB, email, to, `webhook:${provider}`);
    }
    handled++;
  }
  return handled;
}

// ---------- Gmail connection (OAuth) ----------
// The owner clicks "Connect Gmail" in the dashboard, signs in to the dedicated sending account at
// Google, and Google sends a one-time code back here. The Worker exchanges it for a refresh token and
// stores it in the private database. Only the "send email" permission is requested.
const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.send openid email';
const gmailRedirect = (url) => url.origin + '/api/admin/gmail/callback';
async function gmailConnect(env, url) {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) return page('Gmail is not set up yet', '<p>Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET as Worker secrets first.</p>', 503);
  const exp = Date.now() + 10 * 60 * 1000, state = `${exp}.${await hmac(env.SESSION_SECRET, 'gmail-connect.' + exp)}`;
  const q = new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, redirect_uri: gmailRedirect(url), response_type: 'code', scope: GMAIL_SCOPES, access_type: 'offline', prompt: 'consent', state });
  return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
}
async function gmailCallback(env, url) {
  // The session cookie is SameSite=Strict, so it is not sent on the way back from Google.
  // The signed, short-lived state value proves this flow was started from the signed-in dashboard.
  const [exp, sig] = String(url.searchParams.get('state') || '').split('.');
  if (!exp || Number(exp) < Date.now() || !safeEqual(sig || '', await hmac(env.SESSION_SECRET, 'gmail-connect.' + exp))) return page('Connection expired', '<p>Start again from the dashboard: Tools, Connect Gmail.</p>', 400);
  if (url.searchParams.get('error')) return page('Gmail was not connected', `<p>Google reported: ${esc(url.searchParams.get('error'))}. <a href="/admin/#tools">Back to the dashboard</a></p>`, 400);
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, redirect_uri: gmailRedirect(url), grant_type: 'authorization_code' }) });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.refresh_token) return page('Gmail was not connected', `<p>Google did not return a long-lived sign-in (${esc(tok.error || res.status)}). <a href="/admin/#tools">Try again</a>.</p>`, 400);
  if (!String(tok.scope || '').includes('gmail.send')) return page('Permission missing', '<p>The "send email" box was not ticked on Google\'s screen. <a href="/admin/#tools">Try again</a> and leave it ticked.</p>', 400);
  let email = null;
  try { email = JSON.parse(atob(tok.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || null; } catch { /* address is optional */ }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('gmail_refresh_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(tok.refresh_token),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('gmail_from_email', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(email || ''),
  ]);
  await run(env.DB, "DELETE FROM settings WHERE key = 'delivery_last_problem'");
  // Google reports an expiry only while the Google Cloud app is in "Testing" mode (then: 7 days).
  const expires_at = tok.refresh_token_expires_in ? new Date(Date.now() + Number(tok.refresh_token_expires_in) * 1000).toISOString() : null;
  await run(env.DB, "INSERT INTO settings (key, value) VALUES ('gmail_health', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ checked_at: now(), ok: true, error: null, expires_at }));
  await audit(env.DB, 'owner', 'gmail.connect', null, null, { account: email, sign_in_expires: expires_at });
  return Response.redirect((await siteConfig(env)).url + '/admin/#tools', 303);
}

// ---------- admin API ----------
async function adminApi(request, env, path, url) {
  const db = env.DB, method = request.method;
  if (path === 'login' && method === 'POST') {
    if (!env.ADMIN_PASSWORD_HASH || !env.SESSION_SECRET) return fail(503, 'Admin access is not configured (set ADMIN_PASSWORD_HASH and SESSION_SECRET).');
    if (await rateLimited(db, `login:${clientIp(request)}`, 8, 900)) return fail(429, 'Too many attempts. Try again in 15 minutes.');
    const { password } = await body(request, 2000);
    if (!(await verifyPassword(String(password || ''), env.ADMIN_PASSWORD_HASH))) { await audit(db, 'anonymous', 'login.failed', null, null, { ip: clientIp(request) }); return fail(401, 'Wrong password.'); }
    await audit(db, 'owner', 'login.ok');
    return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(env, 'owner') });
  }
  if (path === 'gmail/callback' && method === 'GET') return gmailCallback(env, url);
  const actor = await sessionActor(env, request);
  if (!actor) return fail(401, 'Sign in required.');
  if (path === 'gmail/connect' && method === 'GET') return gmailConnect(env, url);
  if (path === 'deliverability/domain' && method === 'GET') { try { return json(await checkDomain(url.searchParams.get('domain'))); } catch (e) { return fail(400, String(e.message || e)); } }
  if (path === 'ses/status' && method === 'GET') return json(await sesStatus(env, await siteConfig(env)));
  if (path === 'brevo/status' && method === 'GET') return json(await brevoStatus(env, await siteConfig(env)));
  if (path === 'brevo/setup' && method === 'POST') { const r = await brevoSetup(env, await siteConfig(env)); await audit(db, actor, 'brevo.setup', null, null, { ok: r.ok, done: r.done || null }); return json(r, r.ok ? 200 : 400); }
  if (path === 'gmail/check' && method === 'POST') return json({ ok: true, health: await checkGmailHealth(env) });
  if (path === 'gmail/disconnect' && method === 'POST') { await run(db, "DELETE FROM settings WHERE key IN ('gmail_refresh_token','gmail_from_email','gmail_health')"); await audit(db, actor, 'gmail.disconnect'); return json({ ok: true }); }
  if (method !== 'GET' && !sameOrigin(request)) return fail(403, 'Cross-site request blocked.');
  if (path === 'logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': 'prompted_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  if (path === 'me') return json({ ok: true, actor, env: env.SITE_ENV || 'preview', send_mode: env.SEND_MODE === 'live' ? 'live' : 'dryrun' });
  if (path === 'dashboard') return json(await dashboard(env));

  const q = Object.fromEntries(url.searchParams);
  let m;
  // people
  if (path === 'people' && method === 'GET') return json(await listPeople(db, q, { limit: Math.min(200, Number(q.limit) || 50), offset: Number(q.offset) || 0 }));
  if (path === 'people' && method === 'POST') {
    const f = await body(request, 20_000);
    if (await first(db, 'SELECT id FROM people WHERE email_norm = ?', normalizeEmail(f.email))) return fail(409, 'That address is already in the database.');
    if (await first(db, 'SELECT 1 FROM suppressions WHERE email_norm = ?', normalizeEmail(f.email))) return fail(409, 'That address is on the suppression list. It cannot be added by hand.');
    if (f.status === 'active' && f.consent_attested !== true) return fail(400, 'Adding someone as active requires confirming that they agreed to receive Prompted.');
    const person = await createPerson(db, { ...f, status: ['prospective', 'pending', 'active'].includes(f.status) ? f.status : 'prospective', source: f.source || 'manual: added by owner' }, { actor, kind: 'import' });
    await audit(db, actor, 'person.create', 'person', person.id, { status: person.status, consent_attested: f.consent_attested === true });
    return json(await getPerson(db, person.id), 201);
  }
  if (path === 'people/facets') return json({ statuses: STATUSES,
    organizations: (await all(db, 'SELECT name FROM organizations ORDER BY name')).map((r) => r.name),
    tags: (await all(db, 'SELECT DISTINCT tag FROM person_tags ORDER BY tag')).map((r) => r.tag),
    sources: (await all(db, 'SELECT DISTINCT source FROM people WHERE source IS NOT NULL ORDER BY source')).map((r) => r.source),
    campaigns: (await all(db, 'SELECT DISTINCT utm_campaign FROM people WHERE utm_campaign IS NOT NULL ORDER BY utm_campaign')).map((r) => r.utm_campaign) });
  if ((m = /^people\/(\d+)$/.exec(path))) {
    if (method === 'GET') return json(await getPerson(db, Number(m[1])));
    if (method === 'PATCH') return json(await updatePerson(db, Number(m[1]), await body(request, 50_000), actor));
  }
  if ((m = /^people\/(\d+)\/status$/.exec(path)) && method === 'POST') {
    const { status, reason, consent_attested } = await body(request, 5000);
    const person = await first(db, 'SELECT * FROM people WHERE id = ?', Number(m[1]));
    if (!person) return fail(404, 'No such person.');
    if (status === 'active') {
      // Re-activation is deliberate, owner-attested and audited. It is never a side effect of an import.
      if (consent_attested !== true) return fail(400, 'Activating a subscriber requires confirming that they agreed to receive Prompted.');
      if (['bounced', 'complained'].includes(person.status)) return fail(409, `A ${person.status} address cannot be re-activated here.`);
      await run(db, "DELETE FROM suppressions WHERE email_norm = ? AND reason IN ('unsubscribed','manual')", person.email_norm);
    }
    await setStatus(db, person, status, { reason: reason || 'changed by owner', actor });
    await audit(db, actor, 'person.status', 'person', person.id, { from: person.status, to: status, reason: reason || null, consent_attested: consent_attested === true });
    return json(await getPerson(db, person.id));
  }
  if ((m = /^people\/(\d+)\/interactions$/.exec(path)) && method === 'POST') {
    const { kind, body: text } = await body(request, 20_000);
    if (!String(text || '').trim()) return fail(400, 'Write a note first.');
    await run(db, 'INSERT INTO interactions (person_id, kind, body, actor, at) VALUES (?, ?, ?, ?, ?)', Number(m[1]), String(kind || 'note').slice(0, 40), String(text).slice(0, 5000), actor, now());
    return json(await getPerson(db, Number(m[1])));
  }
  if (path === 'people/tag-filtered' && method === 'POST') {
    const b = await body(request, 5000), tag = String(b.tag || '').trim().slice(0, 60);
    if (!tag) return fail(400, 'Give the tag a name.');
    const { where, args } = peopleQuery(b.filters || {});
    const limit = Number.isInteger(b.limit) && b.limit > 0 ? b.limit : null;
    // Oldest subscribers first when a limit is given: the longest-standing readers make the safest pilot group.
    const pick = `SELECT p.id FROM people p ${where} ORDER BY COALESCE(p.subscribed_at, p.created_at), p.id${limit ? ' LIMIT ' + limit : ''}`;
    const res = b.remove === true
      ? await run(db, `DELETE FROM person_tags WHERE tag = ? AND person_id IN (${pick})`, tag, ...args)
      : await run(db, `INSERT INTO person_tags (person_id, tag) SELECT id, ? FROM (${pick}) WHERE true ON CONFLICT DO NOTHING`, tag, ...args);
    const total = (await first(db, 'SELECT COUNT(*) AS n FROM person_tags WHERE tag = ?', tag)).n;
    await audit(db, actor, b.remove === true ? 'people.untag_filtered' : 'people.tag_filtered', null, null, { tag, filters: b.filters || {}, limit, changed: res.meta.changes });
    return json({ ok: true, changed: res.meta.changes, tagged_total: total });
  }
  if (path === 'people/bulk' && method === 'POST') {
    const { ids, action, value } = await body(request, 100_000);
    const list = (ids || []).map(Number).filter(Number.isInteger).slice(0, 90);
    if (!list.length) return fail(400, 'Select at least one person.');
    const marks = list.map(() => '?').join(',');
    if (action === 'tag') await db.batch(list.map((id) => db.prepare('INSERT INTO person_tags (person_id, tag) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(id, String(value).slice(0, 60))));
    else if (action === 'untag') await run(db, `DELETE FROM person_tags WHERE tag = ? AND person_id IN (${marks})`, String(value), ...list);
    else if (action === 'unsubscribe') for (const p of await all(db, `SELECT * FROM people WHERE id IN (${marks})`, ...list)) await setStatus(db, p, 'unsubscribed', { reason: 'bulk action by owner', actor });
    else return fail(400, 'Unknown bulk action.');
    await audit(db, actor, 'people.bulk', null, null, { action, value, count: list.length });
    return json({ ok: true, count: list.length });
  }
  // suppression list
  if (path === 'suppressions' && method === 'GET') return json({ rows: await all(db, 'SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 500') });
  if (path === 'suppressions' && method === 'POST') {
    const { email, reason, detail } = await body(request, 5000);
    await suppress(db, normalizeEmail(email), ['manual', 'invalid', 'bounced', 'complained', 'unsubscribed'].includes(reason) ? reason : 'manual', 'platform', detail || null);
    const person = await first(db, 'SELECT * FROM people WHERE email_norm = ?', normalizeEmail(email));
    if (person && ['active', 'pending', 'prospective'].includes(person.status)) await setStatus(db, person, 'suppressed', { reason: detail || 'suppressed by owner', actor });
    await audit(db, actor, 'suppression.add', 'suppression', normalizeEmail(email), { reason });
    return json({ ok: true });
  }
  // exports and backup
  if (path === 'export/people.csv') {
    const { where, args } = peopleQuery(q);
    const rows = await all(db, `SELECT p.*, (SELECT GROUP_CONCAT(o.name || CASE WHEN m.role IS NULL THEN '' ELSE ' (' || m.role || ')' END, '; ') FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.person_id = p.id) AS organizations,
      (SELECT GROUP_CONCAT(tag, '; ') FROM person_tags t WHERE t.person_id = p.id) AS tags FROM people p ${where} ORDER BY p.id`, ...args);
    await audit(db, actor, 'export.people', null, null, { rows: rows.length, filters: q });
    return new Response(toCsv(PEOPLE_COLUMNS, rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="prompted-people-${now().slice(0, 10)}.csv"`, 'cache-control': 'no-store' } });
  }
  if (path === 'export/backup.json') {
    await audit(db, actor, 'export.backup');
    return new Response(JSON.stringify(await fullBackup(env)), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="prompted-backup-${now().slice(0, 10)}.json"`, 'cache-control': 'no-store' } });
  }
  if (path === 'restore' && method === 'POST') return json(await restoreBackup(env, await body(request, 30_000_000), actor));
  // imports
  if (path === 'imports/preview' && method === 'POST') { const b = await body(request); const plan = await planImport(db, b.csv || '', b); return json({ ...plan, rows: plan.rows.map(({ fields, merge, ...r }) => r) }); }
  if (path === 'imports/commit' && method === 'POST') { const b = await body(request); return json(await commitImport(db, b.csv || '', b, actor)); }
  if (path === 'imports/reconcile' && method === 'POST') { const b = await body(request); const r = await reconcile(db, b.csv || '', b); await audit(db, actor, 'import.reconcile', null, null, { rows: r.rows, in_agreement: r.in_agreement }); return json(r); }
  if (path === 'imports' && method === 'GET') return json({ rows: (await all(db, 'SELECT * FROM import_batches ORDER BY id DESC LIMIT 50')).map((b) => ({ ...b, totals: JSON.parse(b.totals) })) });
  if ((m = /^imports\/(\d+)$/.exec(path))) return json({ batch: await first(db, 'SELECT * FROM import_batches WHERE id = ?', Number(m[1])), rows: await all(db, 'SELECT row_no, email_norm, outcome, detail FROM import_rows WHERE batch_id = ? ORDER BY row_no', Number(m[1])) });
  // issues and sends
  if (path === 'issues') {
    const sends = await all(db, "SELECT id, issue_slug, kind, status, scheduled_at, finished_at FROM sends WHERE status != 'cancelled' ORDER BY id DESC");
    return json({ issues: (await listIssues(env)).reverse().map((i) => ({ ...i, sends: sends.filter((s) => s.issue_slug === i.slug) })), test_recipients: String(env.TEST_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean) });
  }
  // Draft check: turn pasted approved text into an issue, run the same QA a real send must pass, and keep
  // one draft so the exact email can be previewed. Nothing is published and nothing is sent.
  if (path === 'issues/draft' && method === 'POST') {
    const b = await body(request, 400_000);
    let issue;
    try { issue = importIssueText(String(b.text || ''), { number: (await listIssues(env)).length + 1 }); }
    catch (e) { return fail(400, String(e.message || e)); }
    issue.source.content_sha256 = await sha256(blocksText(issue.blocks));
    const existing = (await listIssues(env)).find((i) => i.slug === issue.slug);
    const site = await siteConfig(env);
    const qa = runQA(issue, site, { strict: true });
    await run(db, "INSERT INTO settings (key, value) VALUES ('draft_issue', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(issue));
    await audit(db, actor, 'issue.draft_check', 'issue', issue.slug, { ok: qa.ok, errors: qa.errors, warnings: qa.warnings });
    return json({ issue, qa, filename: `${String(issue.number).padStart(3, '0')}-${issue.slug}.json`, already_published: !!existing,
      subject: renderIssueEmail(issue, site).subject, preview_text: issue.subtitle });
  }
  if (path === 'issues/draft/email' && method === 'GET') {
    const row = await first(db, "SELECT value FROM settings WHERE key = 'draft_issue'");
    if (!row) return fail(404, 'No draft has been checked yet.');
    const issue = JSON.parse(row.value), site = await siteConfig(env), email = renderIssueEmail(issue, site);
    return new Response(fillRecipient(email.html, { unsubscribeUrl: site.url + '/unsubscribed/', webUrl: `${site.url}/issues/${issue.slug}/`, openPixelUrl: null }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if ((m = /^issues\/([a-z0-9-]+)\/qa$/.exec(path))) { const issue = await loadIssue(env, m[1]); return json(runQA(issue, await siteConfig(env), { strict: true })); }
  if ((m = /^issues\/([a-z0-9-]+)\/email$/.exec(path))) {
    const issue = await loadIssue(env, m[1]), site = await siteConfig(env), email = renderIssueEmail(issue, site);
    return new Response(fillRecipient(email.html, { unsubscribeUrl: site.url + '/unsubscribed/', webUrl: `${site.url}/issues/${issue.slug}/`, openPixelUrl: null }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (path === 'sends' && method === 'POST') return json(await prepareSend(env, (await body(request, 2000)).issue_slug, actor), 201);
  if (path === 'sends/test' && method === 'POST') { const b = await body(request, 5000); return json(await testSend(env, b.issue_slug, b.emails, actor), 201); }
  // Delivery diagnostic: a short personal-style message with no links, images or tracking, to an authorised
  // test inbox only. If this reaches the inbox while the newsletter does not, the cause is the links or
  // the layout; if this is filtered too, the cause is the sending account's reputation.
  if (path === 'sends/diagnostic' && method === 'POST') {
    const b = await body(request, 2000), to = normalizeEmail(b.email);
    if (!String(env.TEST_RECIPIENTS || '').split(',').map(normalizeEmail).includes(to)) return fail(403, 'Not an authorised test inbox.');
    const stamp = now().slice(0, 16).replace('T', ' ');
    const text = `Hi,\n\nThis is a plain delivery check from the Prompted platform, sent ${stamp} UTC. It has no links, images or tracking.\n\nIf you can read this in your inbox, plain delivery from the sending account works.\n\nPrompted`;
    const res = await sendTransactional(env, to, `Prompted delivery check ${stamp}`, `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">${esc(text).replace(/\n/g, '<br>')}</div>`, text);
    await audit(db, actor, 'send.diagnostic', null, null, { ok: res.ok, provider: res.provider || null });
    return json({ ok: !!res.ok, provider: res.provider || null, error: res.error || null });
  }
  if ((m = /^sends\/(\d+)$/.exec(path)) && method === 'GET') return json({ ...(await getSend(db, Number(m[1]))), failures: await all(db, "SELECT email_norm, status, last_error, attempts FROM send_recipients WHERE send_id = ? AND status IN ('failed','skipped','bounced','complained') LIMIT 200", Number(m[1])) });
  if ((m = /^sends\/(\d+)\/(approve|schedule|cancel|retry-failed|extend)$/.exec(path)) && method === 'POST') {
    const id = Number(m[1]);
    if (m[2] === 'approve') return json(await approveSend(env, id, actor));
    if (m[2] === 'schedule') { const b = await body(request, 2000); return json(await scheduleSend(env, id, b.at || null, actor, { audience_tag: b.audience_tag || null })); }
    if (m[2] === 'extend') return json(await extendSend(env, id, actor));
    if (m[2] === 'cancel') return json(await cancelSend(env, id, actor));
    return json(await retryFailed(env, id, actor));
  }
  if (path === 'providers') {
    const m = await withMailSettings(env);
    return json({ send_mode: env.SEND_MODE === 'live' ? 'live' : 'dryrun', quotas: await quotas(env), test_quotas: await quotas(env, true), from: env.FROM_EMAIL || null, test_recipients: String(env.TEST_RECIPIENTS || '').split(',').filter(Boolean).length,
      last_problem: JSON.parse((await first(db, "SELECT value FROM settings WHERE key = 'delivery_last_problem'"))?.value || 'null'),
      gmail_health: JSON.parse((await first(db, "SELECT value FROM settings WHERE key = 'gmail_health'"))?.value || 'null'),
      gmail: { client_configured: !!(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET), connected: !!m.GMAIL_REFRESH_TOKEN, account: m.GMAIL_FROM_EMAIL || null, redirect_uri: gmailRedirect(url) },
      configured: { ses: !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY), brevo: !!env.BREVO_API_KEY, resend: !!env.RESEND_API_KEY, postal_address: !/^TODO|not a real address|preview only/i.test((await siteConfig(env)).postal_address) } });
  }
  if (path === 'metrics/beehiiv' && method === 'POST') return json(await importBeehiivMetrics(env, await body(request), actor));
  if (path === 'metrics/growth' && method === 'POST') return json(await importGrowth(env, await body(request), actor));
  if (path === 'placement' && method === 'GET') {
    const rows = await all(db, 'SELECT * FROM placement_tests ORDER BY tested_on DESC, id DESC LIMIT 200');
    // Per sender + inbox: how many of the most recent tests in a row reached the inbox.
    const streaks = {};
    for (const r of rows) { const k = r.sender + ' → ' + r.inbox; const s = (streaks[k] ||= { sender: r.sender, inbox: r.inbox, streak: 0, open: true, last: r.result, last_on: r.tested_on }); if (s.open && r.result === 'inbox') s.streak++; else s.open = false; }
    return json({ rows, streaks: Object.values(streaks).map(({ open, ...s }) => ({ ...s, passes: s.streak >= 3 })) });
  }
  if (path === 'placement' && method === 'POST') {
    const b = await body(request, 4000);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.tested_on || '') || !['inbox', 'promotions', 'spam', 'missing'].includes(b.result) || !String(b.sender || '').trim() || !String(b.inbox || '').trim()) return fail(400, 'Give a date, the sender, the kind of inbox and where the message landed.');
    await run(db, 'INSERT INTO placement_tests (tested_on, sender, inbox, result, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', b.tested_on, String(b.sender).trim().slice(0, 120), String(b.inbox).trim().slice(0, 60), b.result, String(b.note || '').slice(0, 500) || null, actor, now());
    return json({ ok: true }, 201);
  }
  if (path === 'audit') return json({ rows: await all(db, 'SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', Math.min(200, Number(q.limit) || 100), Number(q.offset) || 0) });
  return fail(404, 'Unknown admin endpoint.');
}

// ---------- entry points ----------
const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'SAMEORIGIN',
  'strict-transport-security': 'max-age=31536000', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'cross-origin-opener-policy': 'same-origin' };

async function route(request, env) {
  const url = new URL(request.url), p = url.pathname;
  let m;
  // One address for readers: www goes to the bare domain.
  if (url.hostname.startsWith('www.')) return Response.redirect(`${url.protocol}//${url.hostname.slice(4)}${p}${url.search}`, 301);
  if (p === '/api/subscribe' && request.method === 'POST') return apiSubscribe(request, env);
  if ((m = /^\/confirm\/([a-f0-9]{20,64})$/.exec(p))) return confirmRoute(request, env, m[1]);
  if ((m = /^\/u\/([a-f0-9]{20,64})$/.exec(p))) return unsubscribeRoute(request, env, m[1]);
  if ((m = /^\/o\/(\d+)\/([a-f0-9]{20,64}|test)\.gif$/.exec(p))) return openRoute(env, Number(m[1]), m[2]);
  if ((m = /^\/r\/(\d+)\/(\d+)\/([a-f0-9]{20,64}|test)$/.exec(p))) return clickRoute(env, Number(m[1]), Number(m[2]), m[3]);
  if ((m = /^\/api\/hooks\/([a-z]+)$/.exec(p)) && request.method === 'POST') return webhookRoute(request, env, m[1]);
  if (p.startsWith('/api/admin/')) return adminApi(request, env, p.slice('/api/admin/'.length), url);
  if (p.startsWith('/api/')) return fail(404, 'Unknown endpoint.');
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    let res;
    try { res = await route(request, env); }
    catch (e) {
      if (e instanceof HttpError) res = fail(e.status, e.message);
      else { console.error('unhandled', e?.message); res = fail(500, 'Something went wrong.'); } // never echo internals or personal data
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
    if (env.SITE_ENV !== 'production') out.headers.set('x-robots-tag', 'noindex, nofollow');
    // The dashboard shell loads only its own script and styles; nothing third-party can run there.
    const path = new URL(request.url).pathname;
    if (path.startsWith('/admin')) { out.headers.set('content-security-policy', "default-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"); out.headers.set('x-frame-options', 'DENY'); }
    if (path.startsWith('/api/admin/')) out.headers.set('x-robots-tag', 'noindex, nofollow');
    return out;
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await tick(env);
        const t = new Date();
        if (t.getUTCMinutes() === 0) await pruneRateLimits(env.DB);
        if (t.getUTCMinutes() === 7 && t.getUTCHours() % 6 === 0) await checkGmailHealth(env); // four times a day; sends nothing
        if (t.getUTCMinutes() % 30 === 13) await refreshSesAccount(env); // Amazon's current limits, read-only; sends nothing
        if (t.getUTCHours() === 4 && t.getUTCMinutes() === 21) await env.DB.prepare("DELETE FROM webhook_messages WHERE received_at < ?").bind(new Date(Date.now() - 30 * 86400000).toISOString()).run();
      }
      catch (e) { console.error('cron failed', e?.message); }
    })());
  },
};
