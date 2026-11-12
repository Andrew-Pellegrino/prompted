// Amazon SES (Simple Email Service): send adapter (single and bulk), account status for the dashboard,
// and the translator for SES event reports. Uses the SES v2 HTTPS API directly: no AWS SDK.
//
// Secrets (Worker secrets, never in the repository): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// SES_TOPIC_ARN (the SNS topic that carries event reports; it contains the AWS account number).
// Plain settings: SES_REGION, SES_CONFIGURATION_SET, SES_BULK ("on" once the access key may call
// SendBulkEmail), SES_DAILY_LIMIT, SES_MAX_PER_TICK, SES_CALLS_PER_TICK, SES_USE_IN_SANDBOX.
import { all, run, now } from './core.mjs';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
async function hmacRaw(key, text) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(text));
}
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== null && v !== '' ? Number(v) : d);
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
const hasKeys = (env) => !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);

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
const noBreaks = (pairs) => { for (const [k, v] of pairs) if (/[\r\n]/.test(String(k) + String(v))) throw new Error('Header injection blocked'); };

/** Turn a failed SES call into the platform's vocabulary: pause (not now), bad key, or a plain failure. */
function callFailure(r) {
  const why = `ses ${r.status} ${r.errorType} ${(r.data?.message || r.data?.Message || r.text || '').slice(0, 240)}`.trim();
  // "Not now": the per-second rate, the daily quota, or AWS paused the account. Stop this run; nobody is lost.
  if (r.status === 429 || /TooManyRequests|Throttling|LimitExceeded|SendingPaused|AccountSuspended/i.test(r.errorType + ' ' + r.text)) return { ok: false, rateLimited: true, retryable: true, error: 'Amazon SES says not now: ' + why };
  if (r.status === 403 || /SignatureDoesNotMatch|InvalidClientTokenId|UnrecognizedClient|AccessDenied/i.test(r.errorType)) return { ok: false, authError: true, retryable: true, error: 'Amazon SES refused the access key or its permissions: ' + why };
  return { ok: false, error: why, retryable: r.status >= 500 };
}

// ---------- bulk sending ----------
// One request carries the issue once plus a short entry per person. Each person's own values go in through
// Amazon's template feature, so the only thing that differs per person is their private token.
export const BULK_TOKEN = '{{TOKEN}}';
export const BULK_TRACK = '{{TRACK}}'; // the per-send tracking id (only present when tracking is on)
/** True when the text can go through Amazon's template engine untouched: no other "{{" or "}}" in it. */
export const bulkSafe = (...texts) => texts.every((t) => !/\{\{|\}\}/.test(String(t || '').split(BULK_TOKEN).join('').split(BULK_TRACK).join('')));

export function buildBulkBody(env, batch) {
  noBreaks([['Subject', batch.subject], ...batch.recipients.flatMap((r) => [['To', r.to], ...Object.entries(r.headers || {})])]);
  return {
    FromEmailAddress: `${displayName(batch.from.name)} <${batch.from.email}>`,
    ReplyToAddresses: batch.replyTo ? [batch.replyTo] : undefined,
    ConfigurationSetName: env.SES_CONFIGURATION_SET || undefined,
    DefaultContent: { Template: { TemplateContent: { Subject: batch.subject, Html: batch.html, Text: batch.text || '' }, TemplateData: '{"TOKEN":"","TRACK":""}' } },
    BulkEmailEntries: batch.recipients.map((r) => ({
      Destination: { ToAddresses: [r.to] },
      ReplacementEmailContent: { ReplacementTemplate: { ReplacementTemplateData: JSON.stringify({ TOKEN: r.token, TRACK: r.track || '' }) } },
      ReplacementHeaders: Object.entries(r.headers || {}).map(([Name, Value]) => ({ Name, Value })),
    })),
  };
}

const ENTRY_PAUSE = /^(ACCOUNT_THROTTLED|TRANSIENT_FAILURE|ACCOUNT_DAILY_QUOTA_EXCEEDED|ACCOUNT_SENDING_PAUSED|CONFIGURATION_SET_SENDING_PAUSED|ACCOUNT_SUSPENDED)$/;

/** Amazon's limits as last read from the account (kept in the private database), or null. */
const snapshot = (env) => (env.SES_ACCOUNT && typeof env.SES_ACCOUNT === 'object' ? env.SES_ACCOUNT : null);

/**
 * The IAM policy cannot enforce the From address for bulk requests (AWS has no ses:FromAddress condition
 * for SendBulkEmail), so the platform enforces it: every SES request must come from FROM_EMAIL and use the
 * configured configuration set, or it is refused before anything leaves the Worker.
 */
function guard(env, fromEmail) {
  if (!env.FROM_EMAIL || String(fromEmail).toLowerCase() !== String(env.FROM_EMAIL).toLowerCase()) throw new Error(`SES refused locally: sender must be ${env.FROM_EMAIL || 'FROM_EMAIL'}`);
  if (!env.SES_CONFIGURATION_SET) throw new Error('SES refused locally: SES_CONFIGURATION_SET is not set');
}

export const ses = {
  name: 'ses',
  // Until Amazon grants production access the account can only reach addresses verified inside AWS, so the
  // platform leaves SES out of the chain (tests then go through Brevo). SES_USE_IN_SANDBOX overrides.
  configured: (env) => hasKeys(env) && !!env.FROM_EMAIL && (snapshot(env)?.production_access === true || env.SES_USE_IN_SANDBOX === 'true'),
  // 90% of what Amazon allows per day, unless the owner sets a lower number.
  dailyLimit: (env) => num(env.SES_DAILY_LIMIT, snapshot(env)?.max_24h ? Math.floor(snapshot(env).max_24h * 0.9) : 190),
  // One request per recipient costs about half a millisecond of processor time each, and the free
  // Cloudflare plan allows roughly ten milliseconds per run. Bulk mode is the way to send to a whole list.
  maxPerTick: (env) => num(env.SES_MAX_PER_TICK, 10),
  bulkEnabled: (env) => env.SES_BULK === 'on',
  /** How bulk requests are paced inside one one-minute run. */
  batchPlan(env) {
    const rate = Math.max(1, num(snapshot(env)?.max_rate, 1));           // messages a second Amazon allows
    const perCall = Math.max(1, Math.min(50, Math.floor(rate)));           // a request may not carry more than a second's worth
    // Measured: about 1.2 ms of processor time per request (the issue is serialised and hashed each time),
    // plus about 4 ms the run costs anyway. The free Cloudflare plan allows about 10 ms, so 4 requests a run.
    // On Workers Paid (30 s per run) this can go to 40.
    const calls = Math.max(1, Math.min(40, num(env.SES_CALLS_PER_TICK, 4)));
    const spacingMs = num(env.SES_CALL_SPACING_MS, Math.ceil((perCall / (rate * 0.9)) * 1000)); // stay at 90% of the rate
    return { perCall, calls, spacingMs, perMinute: Math.min(perCall * calls, Math.floor(rate * 0.9 * 55)) };
  },
  async send(env, msg) {
    guard(env, msg.from.email);
    const headers = Object.entries(msg.headers || {});
    noBreaks([...headers, ['Subject', msg.subject], ['To', msg.to]]);
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
    return r.ok ? { ok: true, id: r.data?.MessageId || null } : callFailure(r);
  },
  /** batch = { from, replyTo, subject, html, text, recipients: [{ to, token, headers }] }. One result per recipient, same order. */
  async sendBatch(env, batch) {
    guard(env, batch.from.email);
    const r = await sesCall(env, 'POST', '/v2/email/outbound-bulk-emails', buildBulkBody(env, batch));
    if (!r.ok) { const f = callFailure(r); return batch.recipients.map(() => f); }
    const results = r.data?.BulkEmailEntryResults || [];
    return batch.recipients.map((_, i) => {
      const e = results[i];
      if (!e) return { ok: false, error: 'ses: no result returned for this recipient', retryable: false };
      if (e.Status === 'SUCCESS') return { ok: true, id: e.MessageId || null };
      const why = `ses ${e.Status} ${(e.Error || '').slice(0, 200)}`.trim();
      return ENTRY_PAUSE.test(e.Status) ? { ok: false, rateLimited: true, retryable: true, error: 'Amazon SES says not now: ' + why } : { ok: false, error: why, retryable: false };
    });
  },
};

// ---------- account status ----------
const domainOf = (email) => String(email || '').split('@')[1] || null;
const setting = async (env, key) => { try { return JSON.parse((await all(env.DB, 'SELECT value FROM settings WHERE key = ?', key))[0]?.value || 'null'); } catch { return null; } };
const saveSetting = (env, key, value) => run(env.DB, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));

/** Read Amazon's current limits and keep them in the private database, where the sender picks them up. */
export async function refreshSesAccount(env, account = null) {
  if (!hasKeys(env)) return null;
  const a = account || await sesCall(env, 'GET', '/v2/email/account');
  if (!a.ok) return null;
  const q = a.data?.SendQuota || {};
  const snap = { production_access: !!a.data?.ProductionAccessEnabled, sending_enabled: a.data?.SendingEnabled !== false, max_24h: q.Max24HourSend ?? null, max_rate: q.MaxSendRate ?? null, sent_24h: q.SentLast24Hours ?? null, checked_at: now() };
  await saveSetting(env, 'ses_account', snap);
  return snap;
}

/** Read-only account status for the dashboard. Sends nothing and changes nothing at Amazon. */
export async function sesStatus(env, site) {
  const from = env.FROM_EMAIL || null, region = regionOf(env);
  const reports = (await setting(env, 'ses_reports')) || {};
  const hook = site ? `${site.url}/api/hooks/ses` : '/api/hooks/ses';
  if (!hasKeys(env)) return { configured: false, from, region, next: 'Store the AWS access key in Cloudflare as the Worker secrets AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.' };
  const domain = domainOf(from);
  const [account, identity, cset, lastReport] = await Promise.all([sesCall(env, 'GET', '/v2/email/account'), domain ? sesCall(env, 'GET', '/v2/email/identities/' + amzEncode(domain)) : null,
    env.SES_CONFIGURATION_SET ? sesCall(env, 'GET', '/v2/email/configuration-sets/' + amzEncode(env.SES_CONFIGURATION_SET)) : null,
    all(env.DB, "SELECT MAX(received_at) AS at, COUNT(*) AS n FROM webhook_messages WHERE provider = 'ses'")]);
  if (!account.ok) return { configured: true, key_valid: false, from, region, next: `Amazon refused the request (${account.status} ${account.errorType}). Check the access key, its permissions and the region.` };
  const snap = await refreshSesAccount(env, account);
  const q = account.data?.SendQuota || {}, id = identity?.ok ? identity.data : null;
  // Auto Validation: set for the whole account, and optionally overridden by the configuration set we send with.
  const threshold = (o) => (o?.ConditionThreshold ? { enabled: o.ConditionThreshold.ConditionThresholdEnabled === 'ENABLED', raw: o.ConditionThreshold.ConditionThresholdEnabled ?? null, level: o.ConditionThreshold.OverallConfidenceThreshold?.ConfidenceVerdictThreshold || null } : null);
  const avAccount = threshold(account.data?.SuppressionAttributes?.ValidationAttributes), avSet = cset?.ok ? threshold(cset.data?.SuppressionOptions?.ValidationOptions) : null;
  const avEffective = avSet || avAccount; // the configuration set wins when it has its own setting
  const withSnap = { ...env, SES_ACCOUNT: snap }, plan = ses.batchPlan(withSnap), bulk = ses.bulkEnabled(env);
  const perMinute = bulk ? plan.perMinute : ses.maxPerTick(env);
  const out = {
    configured: true, key_valid: true, from, region,
    production_access: !!account.data?.ProductionAccessEnabled,
    sending_enabled: account.data?.SendingEnabled !== false,
    standing: account.data?.EnforcementStatus || null,
    quota: { per_day: q.Max24HourSend ?? null, per_second: q.MaxSendRate ?? null, sent_last_24h: q.SentLast24Hours ?? null },
    used_by_platform: ses.configured(withSnap),
    platform_daily_limit: ses.dailyLimit(withSnap),
    pace: { mode: bulk ? 'bulk' : 'one request per person', per_minute: perMinute, minutes_for: Object.fromEntries([255, 1000, 2500, 5000, 10000].map((n) => [n, Math.ceil(n / perMinute)])) },
    domain: id ? { name: domain, verified: !!id.VerifiedForSendingStatus, dkim: id.DkimAttributes?.Status || null, mail_from: id.MailFromAttributes?.MailFromDomain || null, mail_from_status: id.MailFromAttributes?.MailFromDomainStatus || null, default_configuration_set: id.ConfigurationSetName || null } : null,
    configuration_set: env.SES_CONFIGURATION_SET || null,
    configuration_set_found: env.SES_CONFIGURATION_SET ? !!cset?.ok : null,
    reports: { address: hook, topic_pinned: !!env.SES_TOPIC_ARN, subscribed_at: reports.subscribed_at || null, unsubscribed_at: reports.unsubscribed_at || null, received: lastReport[0]?.n || 0, last_received_at: lastReport[0]?.at || null, tracking_seen_at: reports.tracking_seen_at || null },
    auto_validation: { account: avAccount, configuration_set: avSet, active: avEffective ? avEffective.enabled : null, level: avEffective?.enabled ? avEffective.level : null },
    account_suppression_reasons: account.data?.SuppressionAttributes?.SuppressedReasons || null,
    // Amazon's own open and click tracking for VDM. Prompted measures engagement itself, so this should be off.
    vdm_engagement_tracking: account.data?.VdmAttributes?.DashboardAttributes?.EngagementMetrics ?? null,
  };
  out.reports_connected = !!out.reports.subscribed_at && !out.reports.unsubscribed_at;
  const warnings = [];
  if (out.reports.tracking_seen_at) warnings.push('Amazon is reporting opens or clicks, which means Amazon is adding its own tracking pixel and rewriting links in our emails. Untick Opens and Clicks in the event destination to stop that.');
  if (out.account_suppression_reasons && !['BOUNCE', 'COMPLAINT'].every((r) => out.account_suppression_reasons.includes(r))) warnings.push('Amazon\'s own account suppression list is not covering both bounces and complaints. Keep both switched on.');
  if (out.vdm_engagement_tracking === 'ENABLED') warnings.push('Amazon VDM engagement tracking is on, so Amazon adds its own tracking pixel and rewrites links. Prompted measures engagement itself; turn it off in SES, Virtual Deliverability Manager, Settings.');
  if (!bulk) warnings.push('Bulk sending is off, so the platform sends one request per person. That is fine for tests but too slow for the whole list.');
  if (out.domain && out.configuration_set && out.domain.default_configuration_set && out.domain.default_configuration_set !== out.configuration_set) warnings.push(`The domain's default configuration set at Amazon is "${out.domain.default_configuration_set}", not "${out.configuration_set}".`);
  out.warnings = warnings;
  out.next = !from ? 'Set the sender address (FROM_EMAIL).'
    : !out.domain ? `Add ${domain} as a verified identity in Amazon SES (region ${region}).`
    : !out.domain.verified ? 'Waiting for Amazon to see the DKIM records in DNS. This can take up to 72 hours but is usually minutes.'
    : !out.production_access ? 'Waiting for Amazon to approve production access (the request is under review). Until then Amazon only sends to addresses verified inside the AWS account, 200 a day, and the platform does not use it.'
    : !out.sending_enabled ? 'Amazon has paused sending on this account. Open the SES console to see why.'
    : !out.configuration_set ? 'Set the configuration set name (SES_CONFIGURATION_SET).'
    : out.configuration_set_found === false ? `Amazon has no configuration set named "${out.configuration_set}" in ${region}, or the access key may not read it.`
    : !out.reports.topic_pinned ? 'Store the SNS topic\'s full name (ARN) as the Worker secret SES_TOPIC_ARN, so only that topic is accepted.'
    : !out.reports_connected ? `Connect Amazon's delivery reports: in the AWS console, add an HTTPS subscription on the SNS topic with the address ${hook} . The platform confirms it by itself.`
    : out.auto_validation.active && env.SES_ALLOW_AUTO_VALIDATION !== 'true' ? 'Turn off Auto Validation in Amazon SES (Email Validation, Auto Validation). Amazon\'s guesses can hold back real subscribers, and held messages are still billed. Real bounces and complaints are suppressed either way.'
    : 'Ready for an approved test send.';
  out.ready = out.next === 'Ready for an approved test send.';
  return out;
}

// ---------- event reports ----------
// Amazon reports some sends as a "Permanent bounce" although no mailbox ever refused them: Amazon itself
// decided not to send. Treating those as hard bounces would permanently drop real subscribers, so they
// become "held": the message is marked not delivered, the person stays subscribed, the owner reviews.
//  - EmailValidationSuppressed: Amazon's Auto Validation guessed the address is unlikely to deliver.
//  - OnAccountSuppressionList / Suppressed / OnTenantSuppressionList: the address is on Amazon's own
//    do-not-send list from an earlier bounce or complaint.
const HELD = {
  EmailValidationSuppressed: 'Held back by Amazon\'s address check (Auto Validation). Not delivered; no mailbox refused it. The subscriber is unchanged.',
  OnAccountSuppressionList: 'Not sent: the address is on the AWS account\'s own suppression list from an earlier bounce or complaint. The subscriber is unchanged here.',
  Suppressed: 'Not sent: Amazon suppressed this address because of a recent bounce history. The subscriber is unchanged here.',
  OnTenantSuppressionList: 'Not sent: the address is on an Amazon tenant suppression list. The subscriber is unchanged here.',
};

/**
 * Translate one SES event (the JSON inside an SNS notification) into the platform's vocabulary.
 * Every event type Amazon can publish is accounted for:
 *   Bounce -> bounce_hard | bounce_soft | held      Complaint -> complaint | held
 *   Delivery -> delivered                            DeliveryDelay -> delayed (recorded, nothing changes)
 *   Reject, Rendering Failure -> not_sent            Subscription -> unsubscribe (only if they left everything)
 *   Send -> nothing (we already know)                Open, Click -> nothing (the platform does not use Amazon's tracking)
 * Returns { kind, events: [{ type, email, msgId, reason }], ignored }.
 */
export function sesEvents(message) {
  let m = message;
  // Amazon also sends plain-text notices through the topic (for example when an event destination is set up).
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return { kind: 'text notice', events: [], ignored: true }; } }
  const kind = m?.eventType || m?.notificationType || 'unknown', msgId = m?.mail?.messageId || null, to = m?.mail?.destination || [], events = [];
  if (kind === 'Bounce') {
    const held = HELD[m.bounce?.bounceSubType];
    for (const r of m.bounce?.bouncedRecipients || []) events.push(held
      ? { type: 'held', email: r.emailAddress, msgId, reason: held }
      : { type: m.bounce.bounceType === 'Permanent' ? 'bounce_hard' : 'bounce_soft', email: r.emailAddress, msgId, reason: r.diagnosticCode || `${m.bounce.bounceType || ''} ${m.bounce.bounceSubType || ''}`.trim() });
  } else if (kind === 'Complaint') {
    // With this subtype nobody complained just now: Amazon declined to send because of an earlier complaint.
    const held = HELD[m.complaint?.complaintSubType];
    for (const r of m.complaint?.complainedRecipients || []) events.push(held ? { type: 'held', email: r.emailAddress, msgId, reason: held } : { type: 'complaint', email: r.emailAddress, msgId, reason: m.complaint.complaintFeedbackType || null });
  } else if (kind === 'Delivery') {
    for (const email of m.delivery?.recipients || []) events.push({ type: 'delivered', email, msgId, reason: null });
  } else if (kind === 'DeliveryDelay') {
    for (const r of m.deliveryDelay?.delayedRecipients || []) events.push({ type: 'delayed', email: r.emailAddress, msgId, reason: `${m.deliveryDelay.delayType || 'delayed'} ${r.diagnosticCode || ''}`.trim() });
  } else if (kind === 'Reject') {
    for (const email of to) events.push({ type: 'not_sent', email, msgId, reason: 'Amazon refused to send this message: ' + (m.reject?.reason || 'no reason given') });
  } else if (kind === 'Rendering Failure' || kind === 'RenderingFailure') {
    for (const email of to) events.push({ type: 'not_sent', email, msgId, reason: 'Amazon could not build this message: ' + (m.failure?.errorMessage || 'rendering failure').slice(0, 200) });
  } else if (kind === 'Subscription') {
    if (m.subscription?.newTopicPreferences?.unsubscribeAll === true) for (const email of to) events.push({ type: 'unsubscribe', email, msgId, reason: 'unsubscribed through Amazon SES' });
  }
  return { kind, events, ignored: events.length === 0, tracking: kind === 'Open' || kind === 'Click' };
}
