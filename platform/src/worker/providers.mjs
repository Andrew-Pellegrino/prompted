// Email delivery adapters. The rest of the platform only knows this interface:
//
//   provider.name
//   provider.configured(env)  -> boolean
//   provider.dailyLimit(env)  -> number of messages per UTC day on the free tier (minus a safety margin)
//   provider.send(env, msg)   -> { ok, id?, error?, retryable? }
//
//   msg = { from: {email, name}, replyTo, to, subject, html, text, headers: {name: value} }
//
// Adding or swapping a provider means adding one object here; nothing else changes.
// No adapter is used unless SEND_MODE=live; the default is the dry-run adapter, which sends nothing.

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
const errText = async (res) => `${res.status} ${(await res.text()).slice(0, 300)}`;
const retryableStatus = (s) => s === 429 || s >= 500;

export const dryrun = {
  name: 'dryrun',
  configured: () => true,
  dailyLimit: (env) => num(env.DRYRUN_DAILY_LIMIT, 100000),
  async send(env, msg) {
    if (env.DRYRUN_FAIL && msg.to.includes(env.DRYRUN_FAIL)) return { ok: false, error: 'simulated failure', retryable: false };
    return { ok: true, id: 'dryrun-' + crypto.randomUUID() };
  },
};

// Brevo transactional API. Free plan: 300 emails/day (verified from Brevo's pricing page, Nov 2026).
export const brevo = {
  name: 'brevo',
  configured: (env) => !!(env.BREVO_API_KEY && env.FROM_EMAIL),
  dailyLimit: (env) => num(env.BREVO_DAILY_LIMIT, 290),
  async send(env, msg) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: msg.from, to: [{ email: msg.to }], replyTo: msg.replyTo ? { email: msg.replyTo } : undefined,
        subject: msg.subject, htmlContent: msg.html, textContent: msg.text, headers: msg.headers,
      }),
    });
    if (!res.ok) return { ok: false, error: 'brevo ' + (await errText(res)), retryable: retryableStatus(res.status) };
    return { ok: true, id: (await res.json()).messageId || null };
  },
};

// Resend API. Free plan: 100 emails/day, 3,000/month (Resend docs, Nov 2026).
export const resend = {
  name: 'resend',
  configured: (env) => !!(env.RESEND_API_KEY && env.FROM_EMAIL),
  dailyLimit: (env) => num(env.RESEND_DAILY_LIMIT, 95),
  async send(env, msg) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: `${msg.from.name} <${msg.from.email}>`, to: [msg.to], reply_to: msg.replyTo || undefined,
        subject: msg.subject, html: msg.html, text: msg.text, headers: msg.headers,
      }),
    });
    if (!res.ok) return { ok: false, error: 'resend ' + (await errText(res)), retryable: retryableStatus(res.status) };
    return { ok: true, id: (await res.json()).id || null };
  },
};

// Gmail API (a Google account the owner controls). Needs no sender domain: Google signs the mail
// for the account's own address. Consumer accounts are limited to roughly 500 recipients per rolling
// 24 hours (third-party figure; treat as approximate and keep the margin).
const b64url = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const b64 = (text) => { const bytes = new TextEncoder().encode(text); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/(.{76})/g, '$1\r\n'); };
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);

export function buildMime(msg) {
  const boundary = 'prompted_' + crypto.randomUUID().replace(/-/g, '');
  const headers = [
    `From: ${encWord(msg.from.name)} <${msg.from.email}>`, `To: <${msg.to}>`, `Subject: ${encWord(msg.subject)}`,
    msg.replyTo ? `Reply-To: <${msg.replyTo}>` : null,
    ...Object.entries(msg.headers || {}).map(([k, v]) => `${k}: ${v}`),
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  for (const h of headers) if (/[\r\n]/.test(h)) throw new Error('Header injection blocked');
  return [...headers, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(msg.text || ''),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(msg.html),
    `--${boundary}--`, ''].join('\r\n');
}

let gmailToken = null; // { value, expires } cached for the life of the isolate
export const gmail = {
  name: 'gmail',
  configured: (env) => !!(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN),
  dailyLimit: (env) => num(env.GMAIL_DAILY_LIMIT, 400),
  // Gmail API allows 6,000 quota units a minute per user on new projects and a send costs 100,
  // so at most 60 sends a minute. Cron runs once a minute; stay well under.
  maxPerTick: (env) => num(env.GMAIL_MAX_PER_TICK, 30),
  async send(env, msg) {
    // Cached per sign-in, so reconnecting a different account never reuses the old account's access.
    if (!gmailToken || gmailToken.key !== env.GMAIL_REFRESH_TOKEN || gmailToken.expires < Date.now() + 60000) {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }),
      });
      if (!res.ok) {
        const text = await errText(res);
        // invalid_grant: the sign-in was revoked or expired (password change, 7-day test-mode expiry, six months unused).
        if (/invalid_grant|invalid_client|unauthorized_client/.test(text)) return { ok: false, authError: true, retryable: true, error: 'Gmail sign-in has expired or was revoked. Reconnect Gmail in the dashboard (Tools).' };
        return { ok: false, error: 'gmail token ' + text, retryable: retryableStatus(res.status) };
      }
      const j = await res.json();
      gmailToken = { key: env.GMAIL_REFRESH_TOKEN, value: j.access_token, expires: Date.now() + (j.expires_in || 3000) * 1000 };
    }
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { authorization: `Bearer ${gmailToken.value}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: b64url(new TextEncoder().encode(buildMime(msg))) }),
    });
    if (!res.ok) {
      const text = await errText(res);
      if (res.status === 401) { gmailToken = null; return { ok: false, authError: true, retryable: true, error: 'Gmail rejected the sign-in. Reconnect Gmail in the dashboard (Tools).' }; }
      // Per-minute quota or the account's daily sending cap: stop and try again later, without counting it as a failure.
      if (res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quota/i.test(text))) return { ok: false, rateLimited: true, retryable: true, error: 'gmail limit reached: ' + text.slice(0, 160) };
      return { ok: false, error: 'gmail ' + text, retryable: retryableStatus(res.status) };
    }
    return { ok: true, id: (await res.json()).id || null };
  },
};

export const PROVIDERS = { dryrun, brevo, resend, gmail };

/** Providers in preference order. SEND_MODE must be "live" for anything but the dry-run adapter. */
export function providerChain(env, { forTest = false } = {}) {
  const names = String(env.EMAIL_PROVIDERS || 'brevo,resend,gmail').split(',').map((s) => s.trim()).filter(Boolean);
  const real = names.map((n) => PROVIDERS[n]).filter((p) => p && p.name !== 'dryrun' && p.configured(env));
  if (env.SEND_MODE === 'live') return real;
  // Dry-run mode protects the audience. A test send is different: it can only ever go to the owner's
  // authorised test inboxes, so it uses a real provider as soon as one is connected.
  return forTest && real.length ? real : [dryrun];
}

/** Sender identity. Gmail must send as the authorised account; others use the authenticated domain. */
export function senderFor(env, provider) {
  const email = provider.name === 'gmail' ? env.GMAIL_FROM_EMAIL : env.FROM_EMAIL;
  return { from: { email: email || 'prompted@example.invalid', name: env.FROM_NAME || 'Prompted' }, replyTo: env.REPLY_TO || null };
}
