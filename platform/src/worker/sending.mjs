// Publishing pipeline: prepare -> QA -> test -> approve -> schedule -> send -> verify.
// Quota-aware and duplicate-safe. Runs from the cron trigger in small chunks.
import { all, first, run, stmt, now, audit, HttpError, siteConfig, loadIssue } from './core.mjs';
import { providerChain, senderFor } from './providers.mjs';
import { BULK_TOKEN, BULK_TRACK, bulkSafe } from './ses.mjs';
import { selectIndexTerms } from '../lib/index-terms.mjs';
import { normalizeEmail, validEmail } from './people.mjs';
import { runQA } from '../lib/qa.mjs';
import { renderIssueEmail, fillRecipient, emailLinks } from '../lib/render-email.mjs';
import { blocksText } from '../lib/issue-model.mjs';
import { scheduledSendFor, nextSendSlot } from '../lib/weeks.mjs';
import { sha256 } from './core.mjs';
import { esc } from '../lib/html.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const testAllowlist = (env) => String(env.TEST_RECIPIENTS || '').split(',').map(normalizeEmail).filter(Boolean);
// Amazon's mailbox simulator: addresses that belong to no person and only exist to produce a delivery,
// bounce or complaint report. Allowed as test recipients outside production, and only through SES.
export const SIMULATOR = /@simulator\.amazonses\.com$/;
const isTestRecipient = (env, e) => testAllowlist(env).includes(e) || (!isProduction(env) && SIMULATOR.test(e));
// Second fence for the real audience: unless AUDIENCE_SENDING is "enabled", an issue send can only ever use
// the dry-run adapter, whatever SEND_MODE says. Test sends are unaffected (they are fenced by the allowlist).
const audienceLocked = (env, send) => send.kind !== 'test' && env.AUDIENCE_SENDING !== 'enabled';
const isProduction = (env) => env.SITE_ENV === 'production';
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 15 * 60 * 1000;

/**
 * Add mail settings kept in the private database to env. The Gmail refresh token is stored there by the
 * "Connect Gmail" flow, so it never passes through chat, the repository or the owner's clipboard.
 */
export async function withMailSettings(env) {
  if (env._mailSettings) return env;
  const rows = await all(env.DB, "SELECT key, value FROM settings WHERE key IN ('gmail_refresh_token','gmail_from_email','ses_account')");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let sesAccount = env.SES_ACCOUNT || null;
  if (!sesAccount && m.ses_account) { try { sesAccount = JSON.parse(m.ses_account); } catch { sesAccount = null; } }
  return { ...env, _mailSettings: true, SES_ACCOUNT: sesAccount,
    GMAIL_REFRESH_TOKEN: env.GMAIL_REFRESH_TOKEN || (env.GMAIL_CLIENT_ID ? m.gmail_refresh_token : undefined),
    GMAIL_FROM_EMAIL: env.GMAIL_FROM_EMAIL || m.gmail_from_email };
}

export const webUrlFor = (site, issue) => `${site.url}/issues/${issue.slug}/?utm_source=newsletter&utm_medium=email&utm_campaign=${issue.slug}`;

/** The Index terms block is off unless INDEX_TERMS_EMAIL is "on" (every send) or "preview" (test sends and previews only). */
export const indexTermsWanted = (env, forTest) => env.INDEX_TERMS_EMAIL === 'on' || (forTest && env.INDEX_TERMS_EMAIL === 'preview');
export async function loadIndexData(env) {
  try { const r = await env.ASSETS.fetch(new Request('https://assets.local/index/data.json')); return r.ok ? await r.json() : null; } catch { return null; }
}
export async function indexTermsFor(env, issue, site) {
  const data = await loadIndexData(env);
  return data ? selectIndexTerms(issue, data, site.index_url, Number(env.INDEX_TERMS_MAX || 5)) : [];
}

/** Every link this send may track, stored with a label so reports can name them. */
async function linkStatements(env, sendId, issue, site, forTest) {
  const terms = indexTermsWanted(env, forTest) ? await indexTermsFor(env, issue, site) : [];
  return emailLinks(issue, site, webUrlFor(site, issue), terms)
    .map((l, i) => stmt(env.DB, 'INSERT OR IGNORE INTO send_links (send_id, idx, url, label, kind) VALUES (?, ?, ?, ?, ?)', sendId, i, l.url, l.label, l.kind));
}

/** How many recipients one cron run may hand to this provider. */
function perTick(provider, env, send, chunkSize) {
  if (provider.sendBatch && provider.bulkEnabled?.(env)) { const p = provider.batchPlan(env); return p.perCall * p.calls; }
  return provider.maxPerTick ? provider.maxPerTick(env) : chunkSize;
}
const pause = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);

const contentHash = (issue) => sha256(issue.title + '\n' + issue.subtitle + '\n' + blocksText(issue.blocks));

export async function prepareSend(env, slug, actor) {
  const db = env.DB, issue = await loadIssue(env, slug), site = await siteConfig(env);
  const qa = runQA(issue, site, { strict: true });
  const email = renderIssueEmail(issue, site);
  try {
    const res = await run(db, `INSERT INTO sends (issue_slug, kind, subject, preview, status, content_sha256, qa, created_by, created_at) VALUES (?, 'issue', ?, ?, 'draft', ?, ?, ?, ?)`,
      slug, email.subject, email.preview, await contentHash(issue), JSON.stringify(qa), actor, now());
    await audit(db, actor, 'send.prepare', 'send', res.meta.last_row_id, { slug, qa_errors: qa.errors, qa_warnings: qa.warnings });
    return getSend(db, res.meta.last_row_id);
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'This issue already has a send in progress or completed. An issue is only ever sent once.');
    throw e;
  }
}

export async function getSend(db, id) {
  const send = await first(db, 'SELECT * FROM sends WHERE id = ?', id);
  if (!send) throw new HttpError(404, 'No such send.');
  const counts = await all(db, 'SELECT status, COUNT(*) AS n, SUM(opens > 0) AS opened, SUM(clicks > 0) AS clicked FROM send_recipients WHERE send_id = ? GROUP BY status', id);
  const links = await all(db, 'SELECT idx, url, label, kind, clicks FROM send_links WHERE send_id = ? ORDER BY clicks DESC, idx', id);
  const remaining = send.kind === 'issue' ? (await first(db, `SELECT COUNT(*) AS n FROM people WHERE status = 'active' AND email_norm NOT IN (SELECT email_norm FROM suppressions) AND email_norm NOT IN (SELECT email_norm FROM send_recipients WHERE send_id = ?)`, id)).n : 0;
  const via = (await all(db, 'SELECT DISTINCT provider FROM send_recipients WHERE send_id = ? AND provider IS NOT NULL', id)).map((r) => r.provider);
  return { ...send, audience: JSON.parse(send.audience || '{}'), not_yet_included: remaining, providers: via, qa: JSON.parse(send.qa), totals: JSON.parse(send.totals), recipients: Object.fromEntries(counts.map((c) => [c.status, c.n])), opened: counts.reduce((a, c) => a + (c.opened || 0), 0), clicked: counts.reduce((a, c) => a + (c.clicked || 0), 0), links };
}

async function requireFresh(env, send) {
  const issue = await loadIssue(env, send.issue_slug);
  if ((await contentHash(issue)) !== send.content_sha256) throw new HttpError(409, 'The issue changed after this send was prepared. Cancel it and prepare again.');
  return issue;
}

export async function approveSend(env, id, actor) {
  const db = env.DB, send = await first(db, 'SELECT * FROM sends WHERE id = ?', id);
  if (!send || send.kind !== 'issue') throw new HttpError(404, 'No such send.');
  if (send.status !== 'draft') throw new HttpError(409, `Only a draft can be approved (this one is ${send.status}).`);
  const issue = await requireFresh(env, send);
  const qa = runQA(issue, await siteConfig(env), { strict: true });
  if (!qa.ok) throw new HttpError(409, `QA has ${qa.errors} blocking error(s). Fix them before approving.`);
  await run(db, "UPDATE sends SET status = 'approved', approved_at = ?, approved_by = ?, qa = ? WHERE id = ?", now(), actor, JSON.stringify(qa), id);
  await audit(db, actor, 'send.approve', 'send', id, { slug: send.issue_slug });
  return getSend(db, id);
}

export async function scheduleSend(env, id, at, actor, opts = {}) {
  const db = env.DB, send = await first(db, 'SELECT * FROM sends WHERE id = ?', id);
  if (!send || send.kind !== 'issue') throw new HttpError(404, 'No such send.');
  if (!['approved', 'scheduled'].includes(send.status)) throw new HttpError(409, 'A send must be approved by the owner before it can be scheduled.');
  const issue = await requireFresh(env, send);
  let when = at ? new Date(at) : new Date(scheduledSendFor(issue.week).utc);
  if (isNaN(when)) throw new HttpError(400, 'Bad schedule time.');
  if (!at && when <= new Date()) when = new Date(nextSendSlot().utc);
  if (when <= new Date()) throw new HttpError(400, 'The schedule time must be in the future.');
  const audience = opts.audience_tag ? { tag: String(opts.audience_tag).slice(0, 60) } : {};
  await run(db, "UPDATE sends SET status = 'scheduled', scheduled_at = ?, audience = ? WHERE id = ?", when.toISOString(), JSON.stringify(audience), id);
  await audit(db, actor, 'send.schedule', 'send', id, { at: when.toISOString(), audience });
  return getSend(db, id);
}

export async function cancelSend(env, id, actor) {
  const db = env.DB, send = await first(db, 'SELECT * FROM sends WHERE id = ?', id);
  if (!send) throw new HttpError(404, 'No such send.');
  if (!['draft', 'approved', 'scheduled'].includes(send.status)) throw new HttpError(409, `A send that is ${send.status} cannot be cancelled.`);
  await run(db, "UPDATE sends SET status = 'cancelled', finished_at = ? WHERE id = ?", now(), id);
  await audit(db, actor, 'send.cancel', 'send', id);
  return getSend(db, id);
}

/** Test send: only to addresses on the TEST_RECIPIENTS allowlist. Never touches the audience. */
export async function testSend(env, slug, emails, actor) {
  const db = env.DB, allow = testAllowlist(env);
  const list = [...new Set((emails || []).map(normalizeEmail))].filter(validEmail);
  if (!list.length) throw new HttpError(400, 'Give at least one test address.');
  const blocked = list.filter((e) => !isTestRecipient(env, e));
  if (list.some((e) => SIMULATOR.test(e)) && !providerChain(await withMailSettings(env), { forTest: true }).some((p) => p.name === 'ses')) throw new HttpError(409, 'Amazon simulator addresses can only be used when Amazon SES is the sending provider.');
  if (blocked.length) throw new HttpError(403, `Not an authorised test inbox: ${blocked.join(', ')}. Add it to TEST_RECIPIENTS first.`);
  const issue = await loadIssue(env, slug), site = await siteConfig(env), email = renderIssueEmail(issue, site);
  const res = await run(db, `INSERT INTO sends (issue_slug, kind, subject, preview, status, content_sha256, created_by, created_at, started_at) VALUES (?, 'test', ?, ?, 'sending', ?, ?, ?, ?)`,
    slug, '[TEST] ' + email.subject, email.preview, await contentHash(issue), actor, now(), now());
  const id = res.meta.last_row_id;
  // If a test inbox is also a subscriber record, the test carries that record's own unsubscribe and
  // tracking links, so the whole reader journey can be exercised. Otherwise it gets inert "test" links.
  const known = new Map((await all(db, `SELECT id, email_norm, token FROM people WHERE email_norm IN (${list.map(() => '?').join(',')})`, ...list)).map((p) => [p.email_norm, p]));
  await db.batch([
    ...(await linkStatements(env, id, issue, site, true)),
    ...list.map((e) => stmt(db, "INSERT INTO send_recipients (send_id, person_id, email_norm, token, status, track_id) VALUES (?, ?, ?, ?, 'queued', lower(hex(randomblob(12))))", id, known.get(e)?.id ?? null, e, known.get(e)?.token ?? 'test')),
  ]);
  await audit(db, actor, 'send.test', 'send', id, { slug, recipients: list.length });
  await processSend(env, await first(db, 'SELECT * FROM sends WHERE id = ?', id));
  return getSend(db, id);
}

/** Remaining quota per provider today, after the reserve kept for confirmations and tests. */
/**
 * Warm-up cap for today, or null when no warm-up is configured.
 * WARMUP = "YYYY-MM-DD,first-day cap,daily growth factor": the cap starts small and grows each day, so a
 * new sender address builds a history gradually instead of appearing with a full-list send on day one.
 * Before the start date nothing real is sent at all.
 */
export function warmupCap(env, at = new Date()) {
  const [start, first, growth] = String(env.WARMUP || '').split(',').map((s) => s.trim());
  if (!start) return null;
  const days = Math.floor((Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - Date.parse(start + 'T00:00:00Z')) / 864e5);
  if (!(days >= 0)) return 0;
  return Math.floor((Number(first) || 20) * Math.pow(Math.max(1, Number(growth) || 1.25), days));
}

export async function quotas(env, forTest = false) {
  env = await withMailSettings(env);
  const usage = Object.fromEntries((await all(env.DB, 'SELECT provider, count FROM provider_usage WHERE day = ?', today())).map((u) => [u.provider, u.count]));
  const cap = warmupCap(env);
  return providerChain(env, { forTest }).map((p) => ({ name: p.name, limit: p.name === 'dryrun' || cap === null ? p.dailyLimit(env) : Math.min(p.dailyLimit(env), cap), warmup_cap: p.name === 'dryrun' ? null : cap, used: usage[p.name] || 0, remaining: Math.max(0, (p.name === 'dryrun' || cap === null ? p.dailyLimit(env) : Math.min(p.dailyLimit(env), cap)) - (usage[p.name] || 0)) }));
}

async function pickProvider(env, reserve = 0, forTest = false) {
  for (const q of await quotas(env, forTest)) if (q.remaining - reserve > 0) return { provider: providerChain(env, { forTest }).find((p) => p.name === q.name), remaining: q.remaining - reserve };
  return null;
}

const listHeaders = (unsub) => ({ 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });

/** Send one chunk of a send. Called from cron; safe to call repeatedly. */
export async function processSend(env, send) {
  env = await withMailSettings(env);
  const db = env.DB, chunkSize = Number(env.SEND_CHUNK || 20);
  // 1. A claim that never got a result is NOT retried automatically: it may have been delivered.
  await run(db, "UPDATE send_recipients SET status = 'failed', last_error = 'unconfirmed: handed to provider but no result recorded; check the provider log before retrying' WHERE send_id = ? AND status = 'sending' AND claimed_at < ?",
    send.id, new Date(Date.now() - STALE_CLAIM_MS).toISOString());
  const reserve = send.kind === 'test' ? 0 : Number(env.QUOTA_RESERVE || 10);
  if (audienceLocked(env, send)) env = { ...env, SEND_MODE: 'dryrun' };
  const pick = await pickProvider(env, reserve, send.kind === 'test');
  const queued = pick ? await all(db, "SELECT email_norm, token, track_id, person_id, attempts FROM send_recipients WHERE send_id = ? AND status = 'queued' ORDER BY rowid LIMIT ?", send.id, Math.min(pick.remaining, perTick(pick.provider, env, send, chunkSize))) : [];
  // People who unsubscribed, bounced or complained after the audience was fixed are skipped, never sent.
  if (queued.length && send.kind !== 'test') {
    const gone = new Set((await all(db, `SELECT r.email_norm FROM send_recipients r LEFT JOIN people p ON p.id = r.person_id
      WHERE r.send_id = ? AND r.status = 'queued' AND (r.email_norm IN (SELECT email_norm FROM suppressions) OR (r.person_id IS NOT NULL AND p.status <> 'active'))`, send.id)).map((x) => x.email_norm));
    if (gone.size) {
      await db.batch([...gone].map((e) => stmt(db, "UPDATE send_recipients SET status = 'skipped', last_error = 'no longer subscribed when their turn came' WHERE send_id = ? AND email_norm = ? AND status = 'queued'", send.id, e)));
      for (let i = queued.length - 1; i >= 0; i--) if (gone.has(queued[i].email_norm)) queued.splice(i, 1);
    }
  }
  if (queued.length) {
    const { provider } = pick;
    const issue = await loadIssue(env, send.issue_slug), site = await siteConfig(env);
    const links = await all(db, 'SELECT idx, url, label, kind FROM send_links WHERE send_id = ?', send.id);
    const linkIdx = new Map(links.map((l) => [l.url, l.idx]));
    // First-party tracking, off unless switched on. URLs carry only the per-send tracking id.
    const track = env.TRACK_CLICKS === 'true', trackOpens = env.TRACK_OPENS === 'true';
    const tracked = (href) => (linkIdx.has(href) ? `${site.url}/r/{{TRACK}}/${linkIdx.get(href)}` : href);
    const indexTerms = links.filter((l) => l.kind === 'index_term').map((l) => ({ term: l.label, url: l.url }));
    const email = renderIssueEmail(issue, site, { subject: send.subject, preview: send.preview, indexTerms, trackLink: track ? tracked : null });
    const { from, replyTo } = senderFor(env, provider);
    const plainWebUrl = webUrlFor(site, issue), webUrl = track ? tracked(plainWebUrl) : plainWebUrl;
    const pixelUrl = trackOpens ? `${site.url}/o/{{TRACK}}.gif` : null;
    // 2. Claim before sending so a crash cannot produce a duplicate.
    const claimedAt = now();
    await db.batch(queued.map((r) => stmt(db, "UPDATE send_recipients SET status = 'sending', claimed_at = ?, attempts = attempts + 1, provider = ? WHERE send_id = ? AND email_norm = ? AND status = 'queued'", claimedAt, provider.name, send.id, r.email_norm)));
    const results = [];
    const allow = testAllowlist(env);
    let paused = null; // set when the provider says "not now" (rate limit, expired sign-in): nothing more is attempted this run
    // Bulk: the issue goes out once per request with up to a second's worth of recipients; each person's
    // private token is filled in by the provider. Only for the real issue send, and only if nothing else in
    // the email looks like a template placeholder (the editorial text is never altered to make it fit).
    const bulkHtml = provider.sendBatch && provider.bulkEnabled?.(env)
      ? fillRecipient(email.html, { unsubscribeUrl: `${site.url}/u/${BULK_TOKEN}`, webUrl, token: BULK_TOKEN, track: BULK_TRACK, openPixelUrl: pixelUrl }) : null;
    const bulkText = bulkHtml && fillRecipient(email.text, { unsubscribeUrl: `${site.url}/u/${BULK_TOKEN}`, webUrl: plainWebUrl, token: BULK_TOKEN, track: BULK_TRACK, openPixelUrl: null }, false);
    const useBulk = !!bulkHtml && bulkSafe(bulkHtml, bulkText, send.subject);
    const eligible = [];
    for (const r of queued) {
      // Outside production, real providers may only reach authorised test inboxes.
      if (provider.name !== 'dryrun' && !isProduction(env) && !isTestRecipient(env, r.email_norm)) results.push({ r, res: { ok: false, skipped: true, error: 'preview environment: not an authorised test inbox' } });
      else if (SIMULATOR.test(r.email_norm) && provider.name !== 'ses') results.push({ r, res: { ok: false, skipped: true, error: 'simulator addresses are only sent through Amazon SES' } });
      else eligible.push(r);
    }
    if (useBulk) {
      const plan = provider.batchPlan(env);
      for (let i = 0; i < eligible.length; i += plan.perCall) {
        const chunk = eligible.slice(i, i + plan.perCall);
        if (paused) { for (const r of chunk) results.push({ r, res: { ok: false, deferred: true } }); continue; }
        if (i > 0) await pause(plan.spacingMs);
        let out;
        try {
          out = await provider.sendBatch(env, { from, replyTo, subject: send.subject, html: bulkHtml, text: bulkText,
            recipients: chunk.map((r) => ({ to: r.email_norm, token: r.token, track: r.track_id, headers: listHeaders(`${site.url}/u/${r.token}`) })) });
        } catch (e) { out = chunk.map(() => ({ ok: false, error: String(e.message || e).slice(0, 300), retryable: true })); }
        chunk.forEach((r, k) => {
          let res = out[k];
          if (res.authError && send.kind === 'test') res = { ...res, retryable: false };
          else if (res.rateLimited || res.authError) { paused = paused || res; res = { ...res, deferred: true }; }
          results.push({ r, res });
        });
      }
    } else {
      for (const r of eligible) {
        if (paused) { results.push({ r, res: { ok: false, deferred: true } }); continue; }
        const unsub = r.token === 'test' ? `${site.url}/unsubscribed/` : `${site.url}/u/${r.token}`;
        const vars = { unsubscribeUrl: unsub, webUrl, token: r.token, track: r.track_id, openPixelUrl: pixelUrl };
        let res;
        try {
          res = await provider.send(env, { from, replyTo, to: r.email_norm, subject: send.subject, html: fillRecipient(email.html, vars), text: fillRecipient(email.text, { ...vars, webUrl: plainWebUrl, openPixelUrl: null }, false), headers: listHeaders(unsub) });
        } catch (e) { res = { ok: false, error: String(e.message || e).slice(0, 300), retryable: true }; }
        // A test send has no audience to protect: a refused key or permission fails it at once instead of retrying every minute.
        if (res.authError && send.kind === 'test') { res = { ...res, retryable: false }; paused = res; }
        else if (res.rateLimited || res.authError) { paused = res; res = { ...res, deferred: true }; }
        results.push({ r, res });
      }
    }
    if (paused) await run(db, "INSERT INTO settings (key, value) VALUES ('delivery_last_problem', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ at: now(), provider: provider.name, message: paused.error }));
    // 3. Record results in one batch.
    const at = now(), stmts = [];
    let sent = 0;
    for (const { r, res } of results) {
      if (res.ok) {
        sent++;
        stmts.push(stmt(db, "UPDATE send_recipients SET status = 'sent', sent_at = ?, provider_message_id = ?, last_error = NULL WHERE send_id = ? AND email_norm = ?", at, res.id || null, send.id, r.email_norm));
        stmts.push(stmt(db, "INSERT INTO delivery_events (send_id, email_norm, type, provider, at) VALUES (?, ?, 'sent', ?, ?)", send.id, r.email_norm, provider.name, at));
      } else if (res.deferred) {
        // Back to the queue untouched: a provider pause is not a failed attempt.
        stmts.push(stmt(db, "UPDATE send_recipients SET status = 'queued', claimed_at = NULL, attempts = MAX(0, attempts - 1), last_error = ? WHERE send_id = ? AND email_norm = ?", res.error || null, send.id, r.email_norm));
      } else {
        const status = res.skipped ? 'skipped' : res.retryable && r.attempts + 1 < MAX_ATTEMPTS ? 'queued' : 'failed';
        stmts.push(stmt(db, 'UPDATE send_recipients SET status = ?, last_error = ? WHERE send_id = ? AND email_norm = ?', status, res.error || 'unknown error', send.id, r.email_norm));
        if (status === 'failed') stmts.push(stmt(db, "INSERT INTO delivery_events (send_id, email_norm, type, provider, detail, at) VALUES (?, ?, 'failed', ?, ?, ?)", send.id, r.email_norm, provider.name, res.error || null, at));
      }
    }
    if (sent) stmts.push(stmt(db, 'INSERT INTO provider_usage (provider, day, count) VALUES (?, ?, ?) ON CONFLICT(provider, day) DO UPDATE SET count = count + excluded.count', provider.name, today(), sent));
    await db.batch(stmts);
  }
  // 4. Finish when nothing is left queued or in flight.
  const left = await first(db, "SELECT COUNT(*) AS n FROM send_recipients WHERE send_id = ? AND status IN ('queued','sending')", send.id);
  if (left.n === 0) {
    const totals = Object.fromEntries((await all(db, 'SELECT status, COUNT(*) AS n FROM send_recipients WHERE send_id = ? GROUP BY status', send.id)).map((c) => [c.status, c.n]));
    await run(db, "UPDATE sends SET status = 'sent', finished_at = ?, totals = ? WHERE id = ? AND status = 'sending'", now(), JSON.stringify(totals), send.id);
    return { done: true, totals };
  }
  return { done: false, left: left.n, waiting_for_quota: !pick };
}

function audienceFilter(audience) {
  // Optional staged rollout: only people carrying this tag. Everyone else can be added later with extendSend().
  return audience?.tag ? { sql: ' AND id IN (SELECT person_id FROM person_tags WHERE tag = ?)', args: [audience.tag] } : { sql: '', args: [] };
}

/** Cron entry point: start due sends, then advance every send in progress by one chunk. */
export async function tick(env) {
  const db = env.DB, out = [];
  const due = await all(db, "SELECT * FROM sends WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 2", now());
  for (const send of due) {
    const issue = await loadIssue(env, send.issue_slug);
    if ((await contentHash(issue)) !== send.content_sha256) {
      await run(db, "UPDATE sends SET status = 'failed', finished_at = ?, totals = ? WHERE id = ?", now(), JSON.stringify({ error: 'issue content changed after approval; not sent' }), send.id);
      await audit(db, 'cron', 'send.blocked', 'send', send.id, { reason: 'content changed after approval' });
      continue;
    }
    const aud = audienceFilter(JSON.parse(send.audience || '{}'));
    const links = await linkStatements(env, send.id, issue, await siteConfig(env), false);
    await db.batch([
      stmt(db, "UPDATE sends SET status = 'sending', started_at = ? WHERE id = ? AND status = 'scheduled'", now(), send.id),
      // Audience snapshot: active people who are not suppressed. One statement, so it cannot half-run.
      stmt(db, `INSERT OR IGNORE INTO send_recipients (send_id, person_id, email_norm, token, status, track_id)
        SELECT ?, id, email_norm, token, 'queued', lower(hex(randomblob(12))) FROM people WHERE status = 'active' AND email_norm NOT IN (SELECT email_norm FROM suppressions)${aud.sql}`, send.id, ...aud.args),
      ...links,
    ]);
    await audit(db, 'cron', 'send.start', 'send', send.id, { slug: send.issue_slug });
  }
  for (const send of await all(db, "SELECT * FROM sends WHERE status = 'sending' ORDER BY id LIMIT 2")) out.push({ id: send.id, ...(await processSend(env, send)) });
  return out;
}

/**
 * Staged rollout, step two: add every active, unsuppressed subscriber who has not already been queued for
 * this send. The primary key on (send, address) makes it impossible to mail anyone twice.
 */
export async function extendSend(env, id, actor) {
  const db = env.DB, send = await first(db, 'SELECT * FROM sends WHERE id = ?', id);
  if (!send || send.kind !== 'issue') throw new HttpError(404, 'No such send.');
  if (!['sending', 'sent'].includes(send.status)) throw new HttpError(409, 'Only a send that has started can be extended to the rest of the audience.');
  await requireFresh(env, send);
  const res = await run(db, `INSERT OR IGNORE INTO send_recipients (send_id, person_id, email_norm, token, status, track_id)
    SELECT ?, id, email_norm, token, 'queued', lower(hex(randomblob(12))) FROM people WHERE status = 'active' AND email_norm NOT IN (SELECT email_norm FROM suppressions)`, id);
  await run(db, "UPDATE sends SET status = 'sending', finished_at = NULL, audience = '{}' WHERE id = ?", id);
  await audit(db, actor, 'send.extend', 'send', id, { added: res.meta.changes });
  return getSend(db, id);
}

/** Re-queue failed recipients after the owner has checked the provider log. */
export async function retryFailed(env, id, actor) {
  const res = await run(env.DB, "UPDATE send_recipients SET status = 'queued', attempts = 0, last_error = NULL WHERE send_id = ? AND status = 'failed'", id);
  await run(env.DB, "UPDATE sends SET status = 'sending', finished_at = NULL WHERE id = ? AND status = 'sent'", id);
  await audit(env.DB, actor, 'send.retry_failed', 'send', id, { requeued: res.meta.changes });
  return getSend(env.DB, id);
}

/** One-off transactional message (subscription confirmation). Uses the same providers and quota. */
export async function sendTransactional(env, to, subject, html, text) {
  env = await withMailSettings(env);
  // The signup form is public, so on the preview anyone could type the owner's test address into it.
  // A real confirmation email there needs the owner's switch (PREVIEW_CONFIRMATIONS = "live");
  // otherwise it is recorded as a dry run and nothing leaves the platform.
  const realAllowed = isProduction(env) || env.PREVIEW_CONFIRMATIONS === 'live';
  const pick = await pickProvider(env, 0, realAllowed && testAllowlist(env).includes(normalizeEmail(to)));
  if (!pick) return { ok: false, error: 'no sending quota left today' };
  const { provider } = pick;
  if (provider.name !== 'dryrun' && !isProduction(env) && !testAllowlist(env).includes(normalizeEmail(to))) return { ok: false, skipped: true, error: 'preview environment: not an authorised test inbox' };
  const { from, replyTo } = senderFor(env, provider);
  let res;
  try { res = await provider.send(env, { from, replyTo, to, subject, html, text, headers: {} }); } catch (e) { res = { ok: false, error: String(e.message || e) }; }
  if (res.ok) await run(env.DB, 'INSERT INTO provider_usage (provider, day, count) VALUES (?, ?, 1) ON CONFLICT(provider, day) DO UPDATE SET count = count + 1', provider.name, today());
  await run(env.DB, 'INSERT INTO delivery_events (send_id, email_norm, type, provider, detail, at) VALUES (NULL, ?, ?, ?, ?, ?)', normalizeEmail(to), res.ok ? 'confirmation_sent' : 'confirmation_failed', provider.name, res.error || null, now());
  return { ...res, provider: provider.name };
}

export async function sendConfirmation(env, person) {
  const site = await siteConfig(env), url = `${site.url}/confirm/${person.token}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#000;max-width:560px;margin:0 auto;padding:24px">
<p style="font-size:28px;font-weight:bold;margin:0 0 16px">${esc(site.name)}</p>
<p>Please confirm that you want to receive ${esc(site.name)}, a free weekly AI brief sent ${esc(site.send_slot_label)}.</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#c3142d;color:#fff;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:4px">Confirm my subscription</a></p>
<p style="font-size:13px;color:#5f5e58">If you did not ask for this, ignore this email and you will not hear from us again.</p>
<p style="font-size:12px;color:#5f5e58">${esc(site.name)} · ${esc(site.postal_address)}</p></div>`;
  const text = `Please confirm that you want to receive ${site.name}, a free weekly AI brief sent ${site.send_slot_label}.\n\nConfirm: ${url}\n\nIf you did not ask for this, ignore this email.\n\n${site.name} · ${site.postal_address}`;
  return sendTransactional(env, person.email_norm, `Confirm your subscription to ${site.name}`, html, text);
}

/**
 * Check that the stored Gmail sign-in still works, by asking Google for a short-lived access token.
 * Sends nothing. Records the result (and the sign-in's expiry date, which Google only reports while the
 * Google Cloud app is in "Testing" mode) so the dashboard can warn the owner before a Monday send.
 */
export async function checkGmailHealth(env) {
  env = await withMailSettings(env);
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_REFRESH_TOKEN) return null;
  const health = { checked_at: now(), ok: false, error: null, expires_at: null };
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
    const j = await res.json().catch(() => ({}));
    health.ok = res.ok && !!j.access_token;
    if (!health.ok) health.error = /invalid_grant/.test(j.error || '') ? 'The Gmail sign-in has expired or was revoked. Reconnect Gmail.' : `Google answered ${res.status} ${j.error || ''}`.trim();
    if (j.refresh_token_expires_in) health.expires_at = new Date(Date.now() + Number(j.refresh_token_expires_in) * 1000).toISOString();
  } catch (e) { health.error = 'Could not reach Google: ' + String(e.message || e).slice(0, 120); }
  const prev = JSON.parse((await first(env.DB, "SELECT value FROM settings WHERE key = 'gmail_health'"))?.value || '{}');
  if (!health.expires_at && health.ok && prev.expires_at && new Date(prev.expires_at) > new Date()) health.expires_at = prev.expires_at; // keep the date learned at connection time
  await run(env.DB, "INSERT INTO settings (key, value) VALUES ('gmail_health', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(health));
  return health;
}
