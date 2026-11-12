// Amazon SES (Simple Email Service) adapter, account status for the dashboard, and the reader for
// SES bounce and complaint reports. Uses the SES v2 HTTPS API directly: no AWS SDK, no dependencies.
//
// Secrets (Worker secrets, never in the repository): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
// Plain settings: SES_REGION (for example "us-east-1"), SES_CONFIGURATION_SET (optional),
// SES_DAILY_LIMIT (defaults to just under the 200-a-day limit of a new, unapproved account),
// SES_MAX_PER_TICK (messages per one-minute cron run).

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
async function hmacRaw(key, text) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(text));
}
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
const amzEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * AWS Signature Version 4: the proof AWS requires on every request. Returns the headers to send.
 * `path` must already be URL-encoded. Only `host` and `x-amz-date` are signed, which AWS accepts.
 */
export async function awsSign({ accessKeyId, secretAccessKey, region, service, method, host, path, query = '', body = '', at = new Date() }) {
  const amzDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = amzDate.slice(0, 8);
  const canonicalPath = path.split('/').map((seg) => amzEncode(seg)).join('/'); // AWS encodes each segment a second time
  const canonical = [method, canonicalPath, query, `host:${host}\nx-amz-date:${amzDate}\n`, 'host;x-amz-date', await sha256Hex(body)].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
  let key = await hmacRaw('AWS4' + secretAccessKey, day);
  for (const part of [region, service, 'aws4_request']) key = await hmacRaw(key, part);
  return { 'x-amz-date': amzDate, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=host;x-amz-date, Signature=${hex(await hmacRaw(key, toSign))}` };
}

const regionOf = (env) => String(env.SES_REGION || 'us-east-1');
const ready = (env) => !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);

async function sesCall(env, method, path, bodyObj) {
  const host = `email.${regionOf(env)}.amazonaws.com`, body = bodyObj ? JSON.stringify(bodyObj) : '';
  const signed = await awsSign({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, region: regionOf(env), service: 'ses', method, host, path, body });
  const res = await fetch(`https://${host}${path}`, { method, headers: { ...signed, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body || undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* AWS sometimes answers with plain text */ }
  return { ok: res.ok, status: res.status, data, text, errorType: res.headers.get('x-amzn-errortype') || data?.__type || '' };
}

const displayName = (name) => { const s = String(name || '').replace(/["\\\r\n<>]/g, ''); return /^[\x20-\x7e]*$/.test(s) ? `"${s}"` : `=?UTF-8?B?${btoa(String.fromCharCode(...enc.encode(s)))}?=`; };

export const ses = {
  name: 'ses',
  configured: (env) => ready(env) && !!env.FROM_EMAIL,
  dailyLimit: (env) => num(env.SES_DAILY_LIMIT, 190),
  // One request per recipient. The free Cloudflare plan allows 50 outside requests per cron run and the
  // database calls count too, so 30 leaves room. On the paid Workers plan this can be raised a great deal.
  maxPerTick: (env) => num(env.SES_MAX_PER_TICK, 30),
  async send(env, msg) {
    const headers = Object.entries(msg.headers || {});
    for (const [k, v] of [...headers, ['Subject', msg.subject], ['To', msg.to]]) if (/[\r\n]/.test(k + v)) throw new Error('Header injection blocked');
    const r = await sesCall(env, 'POST', '/v2/email/outbound-emails', {
      FromEmailAddress: `${displayName(msg.from.name)} <${msg.from.email}>`,
      Destination: { ToAddresses: [msg.to] },
      ReplyToAddresses: msg.replyTo ? [msg.replyTo] : undefined,
      ConfigurationSetName: env.SES_CONFIGURATION_SET || undefined,
      Content: { Simple: {
        Subject: { Data: msg.subject, Charset: 'UTF-8' },
        Body: { Html: { Data: msg.html, Charset: 'UTF-8' }, Text: { Data: msg.text || '', Charset: 'UTF-8' } },
        Headers: headers.length ? headers.map(([Name, Value]) => ({ Name, Value })) : undefined,
      } },
    });
    if (r.ok) return { ok: true, id: r.data?.MessageId || null };
    const why = `ses ${r.status} ${r.errorType} ${(r.data?.message || r.data?.Message || r.text || '').slice(0, 240)}`.trim();
    // "Not now": the per-second rate, the daily quota, or AWS paused the account. Stop this run; nobody is lost.
    if (r.status === 429 || /TooManyRequests|Throttling|LimitExceeded|SendingPaused|AccountSuspended/i.test(r.errorType + ' ' + r.text)) return { ok: false, rateLimited: true, retryable: true, error: 'Amazon SES says not now: ' + why };
    if (r.status === 403 || /SignatureDoesNotMatch|InvalidClientTokenId|UnrecognizedClient|AccessDenied/i.test(r.errorType)) return { ok: false, authError: true, retryable: true, error: 'Amazon SES refused the access key: ' + why };
    return { ok: false, error: why, retryable: r.status >= 500 };
  },
};

const domainOf = (email) => String(email || '').split('@')[1] || null;

/** Read-only account status for the dashboard. Sends nothing and changes nothing. */
export async function sesStatus(env) {
  const from = env.FROM_EMAIL || null, region = regionOf(env);
  if (!ready(env)) return { configured: false, from, region, next: 'Store the AWS access key in Cloudflare as the Worker secrets AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.' };
  const domain = domainOf(from);
  const [account, identity] = await Promise.all([sesCall(env, 'GET', '/v2/email/account'), domain ? sesCall(env, 'GET', '/v2/email/identities/' + amzEncode(domain)) : null]);
  if (!account.ok) return { configured: true, key_valid: false, from, region, next: `Amazon refused the request (${account.status} ${account.errorType}). Check the access key, its permissions and the region.` };
  const q = account.data?.SendQuota || {}, id = identity?.ok ? identity.data : null;
  const out = {
    configured: true, key_valid: true, from, region,
    production_access: !!account.data?.ProductionAccessEnabled,
    sending_enabled: account.data?.SendingEnabled !== false,
    standing: account.data?.EnforcementStatus || null,
    quota: { per_day: q.Max24HourSend ?? null, per_second: q.MaxSendRate ?? null, sent_last_24h: q.SentLast24Hours ?? null },
    platform_daily_limit: ses.dailyLimit(env), platform_per_minute: ses.maxPerTick(env),
    domain: id ? { name: domain, verified: !!id.VerifiedForSendingStatus, dkim: id.DkimAttributes?.Status || null, mail_from: id.MailFromAttributes?.MailFromDomain || null, mail_from_status: id.MailFromAttributes?.MailFromDomainStatus || null } : null,
    reports_configured: !!env.SES_CONFIGURATION_SET,
  };
  out.next = !from ? 'Set the sender address (FROM_EMAIL).'
    : !out.domain ? `Add ${domain} as a verified identity in Amazon SES (region ${region}).`
    : !out.domain.verified ? 'Waiting for Amazon to see the DKIM records in DNS. This can take up to 72 hours but is usually minutes.'
    : !out.production_access ? 'Request production access in Amazon SES. Until then SES only sends to verified addresses, 200 a day.'
    : !out.sending_enabled ? 'Amazon has paused sending on this account. Open the SES console to see why.'
    : !out.reports_configured ? 'Connect bounce and complaint reports (configuration set and SNS topic).'
    : 'Ready for an approved test send.';
  out.ready = out.next === 'Ready for an approved test send.';
  return out;
}

/**
 * Amazon delivers SES bounce, complaint and delivery reports through its notification service (SNS),
 * which POSTs to our webhook. Returns { confirm } for the one-time subscription handshake, or
 * { events: [{ type, email, msgId, reason }] } in the platform's own vocabulary.
 */
export function readSesNotification(payload, env) {
  if (env.SES_TOPIC_ARN && payload?.TopicArn !== env.SES_TOPIC_ARN) return { events: [], rejected: 'unexpected topic' };
  if (payload?.Type === 'SubscriptionConfirmation') {
    let u = null;
    try { u = new URL(payload.SubscribeURL); } catch { /* not a URL */ }
    // Only ever call Amazon's own notification service, whatever the message says.
    if (!u || u.protocol !== 'https:' || !/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) return { events: [], rejected: 'confirmation address is not Amazon SNS' };
    return { events: [], confirm: u.href };
  }
  if (payload?.Type !== 'Notification') return { events: [] };
  let m = null;
  try { m = typeof payload.Message === 'string' ? JSON.parse(payload.Message) : payload.Message; } catch { return { events: [] }; }
  const kind = m?.eventType || m?.notificationType, msgId = m?.mail?.messageId || null, events = [];
  if (kind === 'Bounce') for (const r of m.bounce?.bouncedRecipients || []) events.push({ type: m.bounce.bounceType === 'Permanent' ? 'bounce_hard' : 'bounce_soft', email: r.emailAddress, msgId, reason: r.diagnosticCode || `${m.bounce.bounceType || ''} ${m.bounce.bounceSubType || ''}`.trim() });
  if (kind === 'Complaint') for (const r of m.complaint?.complainedRecipients || []) events.push({ type: 'complaint', email: r.emailAddress, msgId, reason: m.complaint.complaintFeedbackType || null });
  if (kind === 'Delivery') for (const email of m.delivery?.recipients || []) events.push({ type: 'delivered', email, msgId, reason: null });
  return { events };
}
