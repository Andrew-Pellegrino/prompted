// Amazon SNS message authentication. Every message Amazon's notification service delivers is signed with
// a certificate that Amazon publishes. We check, in this order:
//   1. the message is one of the three SNS kinds and names the topic we expect (SES_TOPIC_ARN);
//   2. its certificate address is Amazon's own SNS host, over HTTPS, ending in .pem;
//   3. the RSA signature over Amazon's canonical "string to sign" is valid (SignatureVersion 1 = SHA-1,
//      2 = SHA-256);
//   4. the timestamp is recent (an old, captured message cannot be replayed later).
// Duplicate deliveries are caught separately by MessageId (see webhook_messages).
// No secret is needed in the subscription address: only Amazon can produce a valid signature.

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;   // SNS retries for well under an hour with its default policy
const MAX_SKEW_MS = 15 * 60 * 1000;      // a message from the future is refused too

const FIELDS = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

/** Amazon's canonical text that the signature covers. Subject is included only when present. */
export function stringToSign(m) {
  return FIELDS[m.Type].filter((k) => m[k] !== undefined && m[k] !== null).map((k) => `${k}\n${m[k]}\n`).join('');
}

export function isAmazonSnsUrl(value, { pem = false } = {}) {
  let u;
  try { u = new URL(value); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443') && SNS_HOST.test(u.hostname) && (!pem || /\.pem$/.test(u.pathname));
}

// ---- just enough DER reading to take the public key out of an X.509 certificate ----
function derItem(bytes, at) {
  const tag = bytes[at];
  let len = bytes[at + 1], head = 2;
  if (len & 0x80) { const n = len & 0x7f; if (n < 1 || n > 4) throw new Error('bad DER length'); len = 0; for (let i = 0; i < n; i++) len = (len * 256) + bytes[at + 2 + i]; head = 2 + n; }
  if (at + head + len > bytes.length) throw new Error('DER item runs past the end');
  return { tag, start: at, body: at + head, end: at + head + len };
}
function children(bytes, item) { const out = []; for (let p = item.body; p < item.end;) { const c = derItem(bytes, p); out.push(c); p = c.end; } return out; }

/** Certificate -> tbsCertificate -> [version], serial, signature, issuer, validity, subject, subjectPublicKeyInfo. */
export function spkiFromPem(pem) {
  const b64 = String(pem).replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const cert = derItem(bytes, 0);
  const tbs = children(bytes, cert)[0];
  const parts = children(bytes, tbs);
  const offset = parts[0].tag === 0xa0 ? 1 : 0; // explicit version tag is optional
  const spki = parts[offset + 5];
  if (!spki || spki.tag !== 0x30) throw new Error('certificate has no public key');
  const validity = children(bytes, parts[offset + 3]).map((t) => derTime(bytes, t));
  return { spki: bytes.slice(spki.start, spki.end), notBefore: validity[0], notAfter: validity[1] };
}
function derTime(bytes, item) {
  const s = new TextDecoder().decode(bytes.slice(item.body, item.end));
  const m = item.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  const year = item.tag === 0x17 ? (Number(m[1]) < 50 ? 2000 : 1900) + Number(m[1]) : Number(m[1]);
  return new Date(Date.UTC(year, m[2] - 1, m[3], m[4], m[5], m[6]));
}

const certCache = new Map(); // certificate URL -> { spki, notBefore, notAfter }, for the life of the isolate

async function loadCert(url, fetchImpl) {
  if (certCache.has(url)) return certCache.get(url);
  const res = await fetchImpl(url, { redirect: 'manual' });
  if (!res.ok) throw new Error(`certificate download failed (${res.status})`);
  const cert = spkiFromPem(await res.text());
  if (certCache.size > 20) certCache.clear();
  certCache.set(url, cert);
  return cert;
}

/**
 * Verify one SNS message. Returns { ok: true } or { ok: false, reason }.
 * opts: { topicArn, now (ms), fetch }
 */
export async function verifySnsMessage(m, opts = {}) {
  const fetchImpl = opts.fetch || fetch, nowMs = opts.now ?? Date.now();
  if (!m || typeof m !== 'object' || !FIELDS[m.Type]) return { ok: false, reason: 'not an SNS message' };
  if (!opts.topicArn) return { ok: false, reason: 'no topic is configured (SES_TOPIC_ARN)' };
  if (m.TopicArn !== opts.topicArn) return { ok: false, reason: 'unexpected topic' };
  for (const k of FIELDS[m.Type]) if (k !== 'Subject' && typeof m[k] !== 'string') return { ok: false, reason: `missing ${k}` };
  if (m.SignatureVersion !== '1' && m.SignatureVersion !== '2') return { ok: false, reason: 'unknown signature version' };
  if (!isAmazonSnsUrl(m.SigningCertURL, { pem: true })) return { ok: false, reason: 'certificate address is not Amazon SNS' };
  const at = Date.parse(m.Timestamp);
  if (!Number.isFinite(at)) return { ok: false, reason: 'bad timestamp' };
  if (nowMs - at > MAX_AGE_MS) return { ok: false, reason: 'message is too old' };
  if (at - nowMs > MAX_SKEW_MS) return { ok: false, reason: 'message is from the future' };
  let cert;
  try { cert = await loadCert(m.SigningCertURL, fetchImpl); } catch (e) { return { ok: false, reason: 'certificate: ' + e.message, retry: true }; }
  if ((cert.notBefore && nowMs < cert.notBefore.getTime()) || (cert.notAfter && nowMs > cert.notAfter.getTime())) return { ok: false, reason: 'certificate is not currently valid' };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey('spki', cert.spki, { name: 'RSASSA-PKCS1-v1_5', hash: m.SignatureVersion === '2' ? 'SHA-256' : 'SHA-1' }, false, ['verify']);
    const sig = Uint8Array.from(atob(String(m.Signature || '')), (c) => c.charCodeAt(0));
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(stringToSign(m)));
  } catch (e) { return { ok: false, reason: 'signature check failed: ' + (e.message || e) }; }
  return valid ? { ok: true } : { ok: false, reason: 'bad signature' };
}

export const _clearCertCache = () => certCache.clear();
