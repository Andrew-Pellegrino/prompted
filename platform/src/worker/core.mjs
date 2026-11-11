// Shared Worker helpers: D1 access, responses, crypto, rate limiting, audit.
export const now = () => new Date().toISOString();
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
export const fail = (status, message, extra = {}) => json({ ok: false, message, ...extra }, status);

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
export const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
export const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
export const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const enc = new TextEncoder();

export const randomToken = (bytes = 20) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
export const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Password hashing: PBKDF2-SHA256. Stored form: pbkdf2$<iterations>$<saltHex>$<hashHex>. */
export async function hashPassword(password, iterations = 100000, saltHex = randomToken(16)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations }, key, 256);
  return `pbkdf2$${iterations}$${saltHex}$${hex(bits)}`;
}
export async function verifyPassword(password, stored) {
  const [scheme, a, b] = String(stored || '').split('$');
  // sha256$<salt>$<hash>: for a long, randomly generated password (see scripts/make-admin-secret.mjs).
  // Cheap to verify, which matters on the Workers free plan (10 ms CPU), and safe because the
  // password itself has ~120 bits of entropy and logins are rate limited.
  if (scheme === 'sha256' && b) return safeEqual(await sha256(a + password), b);
  if (scheme !== 'pbkdf2' || !b) return false;
  return safeEqual(await hashPassword(password, Number(a), b), stored);
}

/** Fixed-window rate limit stored in D1. Returns true when the caller is over the limit. */
export async function rateLimited(db, key, limit, windowSeconds) {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  await run(db, 'INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1', key, windowStart);
  const row = await first(db, 'SELECT count FROM rate_limits WHERE key = ? AND window_start = ?', key, windowStart);
  return row.count > limit;
}
export const pruneRateLimits = (db) => run(db, 'DELETE FROM rate_limits WHERE window_start < ?', Math.floor(Date.now() / 1000) - 86400);

export const audit = (db, actor, action, entity = null, entityId = null, detail = null) =>
  run(db, 'INSERT INTO audit_log (at, actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)', now(), actor, action, entity, entityId === null ? null : String(entityId), detail === null ? null : JSON.stringify(detail));

export const clientIp = (request) => request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'local';

/** Site configuration served from static assets (written by the build). */
export async function siteConfig(env) {
  const res = await env.ASSETS.fetch(new Request('https://assets.local/data/site.json'));
  if (!res.ok) throw new HttpError(500, 'Site configuration is missing from the build.');
  const site = await res.json();
  const url = (env.SITE_URL || site.url).replace(/\/$/, '');
  return { ...site, url, asset_base_url: url, index_url: url + '/index/', forward_subscribe_url: url + '/s/forward/', postal_address: env.POSTAL_ADDRESS || 'TODO: owner mailing address (required before any real send)' };
}
export async function loadIssue(env, slug) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new HttpError(400, 'Bad issue slug.');
  const res = await env.ASSETS.fetch(new Request(`https://assets.local/data/issues/${slug}.json`));
  if (!res.ok) throw new HttpError(404, `Issue "${slug}" is not in the published build.`);
  return res.json();
}
export async function listIssues(env) {
  const res = await env.ASSETS.fetch(new Request('https://assets.local/data/issues.json'));
  return res.ok ? res.json() : [];
}
