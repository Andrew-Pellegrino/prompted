// Reader sign-in for gated issue pages.
//
// With READER_GATE = "on", an issue page carries only its opening; the rest is held in the Worker bundle under
// /gated/<slug>.html and is served only to a signed-in reader (an active subscriber). Signing in: the reader
// enters their email, gets a one-time link valid for 30 minutes, and the link sets a signed cookie for 180 days.
// The answer to "send me a link" never reveals whether an address is subscribed.
// Before cutover the gate is off and /gated/ is closed to everyone; sign-in emails go only to TEST_RECIPIENTS
// (sendTransactional enforces that outside production).
import { json, fail, first, hmac, safeEqual, rateLimited, clientIp } from './core.mjs';
import { normalizeEmail, validEmail } from './people.mjs';
import { sendTransactional } from './sending.mjs';

const LINK_MS = 30 * 60 * 1000, SESSION_S = 180 * 86400;
const secret = (env) => env.SESSION_SECRET || '';
const b64u = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
const gateOn = (env) => env.READER_GATE === 'on';

async function sign(env, kind, payload) { const body = b64u(JSON.stringify(payload)); return `${body}.${(await hmac(secret(env), kind + '.' + body)).slice(0, 40)}`; }
async function verify(env, kind, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !secret(env) || !safeEqual(sig, (await hmac(secret(env), kind + '.' + body)).slice(0, 40))) return null;
  try { const p = JSON.parse(unb64u(body)); return p.exp > Date.now() ? p : null; } catch { return null; }
}

/** The signed-in reader, or null. Checks the subscriber is still active, so unsubscribing ends access. */
export async function currentReader(request, env) {
  const m = /(?:^|;\s*)prompted_reader=([^;]+)/.exec(request.headers.get('cookie') || '');
  const p = m && await verify(env, 'session', decodeURIComponent(m[1]));
  if (!p) return null;
  const person = await first(env.DB, "SELECT id, email_norm, status FROM people WHERE id = ?", p.id);
  return person && person.status === 'active' ? person : null;
}

const siteBase = (env, request) => (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');

export async function readerRoute(request, env, p) {
  const url = new URL(request.url);
  // POST /api/reader/link {email, next}: email a sign-in link if the address is an active subscriber.
  if (p === '/api/reader/link' && request.method === 'POST') {
    const generic = json({ ok: true, message: 'If that address is subscribed, a sign-in link is on its way. It works for 30 minutes.' });
    if (!gateOn(env)) return fail(409, 'Sign-in opens when Prompted moves to this site.');
    let body = {}; try { body = await request.json(); } catch { /* empty */ }
    const email = normalizeEmail(body.email || '');
    if (!validEmail(email)) return fail(400, 'Enter a valid email address.');
    if (await rateLimited(env.DB, 'reader-ip:' + clientIp(request), 10, 3600) || await rateLimited(env.DB, 'reader-mail:' + email, 3, 3600)) return generic;
    const person = await first(env.DB, "SELECT id, email_norm, status FROM people WHERE email_norm = ?", email);
    if (!person || person.status !== 'active') return generic;
    const next = /^\/issues\/[a-z0-9-]+\/$/.test(body.next || '') ? body.next : '/';
    const t = await sign(env, 'link', { id: person.id, next, exp: Date.now() + LINK_MS });
    const link = `${siteBase(env, request)}/reader/verify?t=${encodeURIComponent(t)}`;
    const html = `<p>Here is your link to keep reading Prompted on the web:</p><p><a href="${link}">Sign in and keep reading</a></p><p>It works for 30 minutes. If you did not ask for it, you can ignore this email.</p><p>— Prompted</p>`;
    const text = `Here is your link to keep reading Prompted on the web:\n\n${link}\n\nIt works for 30 minutes. If you did not ask for it, you can ignore this email.\n\n— Prompted`;
    await sendTransactional(env, person.email_norm, 'Your Prompted sign-in link', html, text, { kind: 'reader_signin' });
    return generic;
  }
  // GET /reader/verify?t=...: set the session cookie and return to the issue.
  if (p === '/reader/verify') {
    const tok = await verify(env, 'link', url.searchParams.get('t'));
    if (!tok) return Response.redirect(siteBase(env, request) + '/issues/?signin=expired', 303);
    const person = await first(env.DB, "SELECT id, status FROM people WHERE id = ?", tok.id);
    if (!person || person.status !== 'active') return Response.redirect(siteBase(env, request) + '/subscribe/', 303);
    const session = await sign(env, 'session', { id: person.id, exp: Date.now() + SESSION_S * 1000 });
    return new Response(null, { status: 303, headers: { location: siteBase(env, request) + tok.next + '#keep-reading', 'set-cookie': `prompted_reader=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_S}` } });
  }
  // GET /api/reader/rest/<slug>: the rest of an issue, for signed-in readers only.
  const m = /^\/api\/reader\/rest\/([a-z0-9-]+)$/.exec(p);
  if (m) {
    if (!gateOn(env)) return fail(404, 'Not found.');
    if (!(await currentReader(request, env))) return fail(401, 'Sign in to keep reading.');
    const r = await env.ASSETS.fetch(new Request(`https://assets.local/gated/${m[1]}.html`));
    if (!r.ok) return fail(404, 'Not found.');
    return new Response(await r.text(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' } });
  }
  if (p === '/api/reader/me') return json({ ok: true, gate: gateOn(env), signedIn: !!(gateOn(env) && await currentReader(request, env)) }, 200, { 'cache-control': 'private, no-store' });
  if (p === '/reader/signout') return new Response(null, { status: 303, headers: { location: siteBase(env, request) + '/', 'set-cookie': 'prompted_reader=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' } });
  return null;
}
