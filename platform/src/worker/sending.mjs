// Publishing pipeline: prepare -> QA -> test -> approve -> schedule -> send -> verify.
// Quota-aware and duplicate-safe. Runs from the cron trigger in small chunks.
import { all, first, run, stmt, now, audit, HttpError, siteConfig, loadIssue } from './core.mjs';
import { providerChain, senderFor } from './providers.mjs';
import { normalizeEmail, validEmail } from './people.mjs';
import { runQA } from '../lib/qa.mjs';
import { renderIssueEmail, fillRecipient } from '../lib/render-email.mjs';
import { blocksText } from '../lib/issue-model.mjs';
import { scheduledSendFor, nextSendSlot } from '../lib/weeks.mjs';
import { sha256 } from './core.mjs';
import { esc } from '../lib/html.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const testAllowlist = (env) => String(env.TEST_RECIPIENTS || '').split(',').map(normalizeEmail).filter(Boolean);
const isProduction = (env) => env.SITE_ENV === 'production';
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 15 * 60 * 1000;

/**
 * Add mail settings kept in the private database to env. The Gmail refresh token is stored there by the
 * "Connect Gmail" flow, so it never passes through chat, the repository or the owner's clipboard.
 */
export async function withMailSettings(env) {
  if (env._mailSettings || !env.GMAIL_CLIENT_ID || env.GMAIL_REFRESH_TOKEN) return env;
  const rows = await all(env.DB, "SELECT key, value FROM settings WHERE key IN ('gmail_refresh_token','gmail_from_email')");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...env, _mailSettings: true, GMAIL_REFRESH_TOKEN: m.gmail_refresh_token, GMAIL_FROM_EMAIL: env.GMAIL_FROM_EMAIL || m.gmail_from_email };
}

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
  const links = await all(db, 'SELECT idx, url, clicks FROM send_links WHERE send_id = ? ORDER BY clicks DESC, idx', id);
  return { ...send, qa: JSON.parse(send.qa), totals: JSON.parse(send.totals), recipients: Object.fromEntries(counts.map((c) => [c.status, c.n])), opened: counts.reduce((a, c) => a + (c.opened || 0), 0), clicked: counts.reduce((a, c) => a + (c.clicked || 0), 0), links };
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

export async function scheduleSend(env, id, at, actor) {
  const db = env.DB, send = await first(db, 'SELECT * FROM sends WHERE id = ?', id);
  if (!send || send.kind !== 'issue') throw new HttpError(404, 'No such send.');
  if (!['approved', 'scheduled'].includes(send.status)) throw new HttpError(409, 'A send must be approved by the owner before it can be scheduled.');
  const issue = await requireFresh(env, send);
  let when = at ? new Date(at) : new Date(scheduledSendFor(issue.week).utc);
  if (isNaN(when)) throw new HttpError(400, 'Bad schedule time.');
  if (!at && when <= new Date()) when = new Date(nextSendSlot().utc);
  if (when <= new Date()) throw new HttpError(400, 'The schedule time must be in the future.');
  await run(db, "UPDATE sends SET status = 'scheduled', scheduled_at = ? WHERE id = ?", when.toISOString(), id);
  await audit(db, actor, 'send.schedule', 'send', id, { at: when.toISOString() });
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
  const blocked = list.filter((e) => !allow.includes(e));
  if (blocked.length) throw new HttpError(403, `Not an authorised test inbox: ${blocked.join(', ')}. Add it to TEST_RECIPIENTS first.`);
  const issue = await loadIssue(env, slug), site = await siteConfig(env), email = renderIssueEmail(issue, site);
  const res = await run(db, `INSERT INTO sends (issue_slug, kind, subject, preview, status, content_sha256, created_by, created_at, started_at) VALUES (?, 'test', ?, ?, 'sending', ?, ?, ?, ?)`,
    slug, '[TEST] ' + email.subject, email.preview, await contentHash(issue), actor, now(), now());
  const id = res.meta.last_row_id;
  await db.batch(list.map((e) => stmt(db, "INSERT INTO send_recipients (send_id, person_id, email_norm, token, status) VALUES (?, NULL, ?, 'test', 'queued')", id, e)));
  await audit(db, actor, 'send.test', 'send', id, { slug, recipients: list.length });
  await processSend(env, await first(db, 'SELECT * FROM sends WHERE id = ?', id));
  return getSend(db, id);
}

/** Remaining quota per provider today, after the reserve kept for confirmations and tests. */
export async function quotas(env) {
  env = await withMailSettings(env);
  const usage = Object.fromEntries((await all(env.DB, 'SELECT provider, count FROM provider_usage WHERE day = ?', today())).map((u) => [u.provider, u.count]));
  return providerChain(env).map((p) => ({ name: p.name, limit: p.dailyLimit(env), used: usage[p.name] || 0, remaining: Math.max(0, p.dailyLimit(env) - (usage[p.name] || 0)) }));
}

async function pickProvider(env, reserve = 0) {
  for (const q of await quotas(env)) if (q.remaining - reserve > 0) return { provider: providerChain(env).find((p) => p.name === q.name), remaining: q.remaining - reserve };
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
  const pick = await pickProvider(env, reserve);
  const queued = pick ? await all(db, "SELECT email_norm, token, person_id, attempts FROM send_recipients WHERE send_id = ? AND status = 'queued' ORDER BY rowid LIMIT ?", send.id, Math.min(chunkSize, pick.remaining)) : [];
  if (queued.length) {
    const { provider } = pick;
    const issue = await loadIssue(env, send.issue_slug), site = await siteConfig(env);
    const links = await all(db, 'SELECT idx, url FROM send_links WHERE send_id = ?', send.id);
    const linkIdx = new Map(links.map((l) => [l.url, l.idx]));
    const track = env.TRACK_CLICKS !== 'false' && send.kind === 'issue';
    const email = renderIssueEmail(issue, site, { subject: send.subject, preview: send.preview, trackLink: track ? (href) => (linkIdx.has(href) ? `${site.url}/r/${send.id}/${linkIdx.get(href)}/{{TOKEN}}` : href) : null });
    const { from, replyTo } = senderFor(env, provider);
    const webUrl = `${site.url}/issues/${issue.slug}/?utm_source=newsletter&utm_medium=email&utm_campaign=${issue.slug}`;
    // 2. Claim before sending so a crash cannot produce a duplicate.
    const claimedAt = now();
    await db.batch(queued.map((r) => stmt(db, "UPDATE send_recipients SET status = 'sending', claimed_at = ?, attempts = attempts + 1, provider = ? WHERE send_id = ? AND email_norm = ? AND status = 'queued'", claimedAt, provider.name, send.id, r.email_norm)));
    const results = [];
    const allow = testAllowlist(env);
    for (const r of queued) {
      // Outside production, real providers may only reach authorised test inboxes.
      if (provider.name !== 'dryrun' && !isProduction(env) && !allow.includes(r.email_norm)) { results.push({ r, res: { ok: false, skipped: true, error: 'preview environment: not an authorised test inbox' } }); continue; }
      const unsub = r.token === 'test' ? `${site.url}/unsubscribed/` : `${site.url}/u/${r.token}`;
      const vars = { unsubscribeUrl: unsub, webUrl, token: r.token, openPixelUrl: env.TRACK_OPENS !== 'false' && send.kind === 'issue' ? `${site.url}/o/${send.id}/${r.token}.gif` : null };
      let res;
      try {
        res = await provider.send(env, { from, replyTo, to: r.email_norm, subject: send.subject, html: fillRecipient(email.html, vars), text: fillRecipient(email.text, vars, false), headers: listHeaders(unsub) });
      } catch (e) { res = { ok: false, error: String(e.message || e).slice(0, 300), retryable: true }; }
      results.push({ r, res });
    }
    // 3. Record results in one batch.
    const at = now(), stmts = [];
    let sent = 0;
    for (const { r, res } of results) {
      if (res.ok) {
        sent++;
        stmts.push(stmt(db, "UPDATE send_recipients SET status = 'sent', sent_at = ?, provider_message_id = ?, last_error = NULL WHERE send_id = ? AND email_norm = ?", at, res.id || null, send.id, r.email_norm));
        stmts.push(stmt(db, "INSERT INTO delivery_events (send_id, email_norm, type, provider, at) VALUES (?, ?, 'sent', ?, ?)", send.id, r.email_norm, provider.name, at));
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
    const urls = [...new Set(issue.blocks.flatMap((b) => (b.type === 'list' ? b.items.flat() : b.children || [])).filter((r) => /^https?:\/\//.test(r.href || '')).map((r) => r.href))];
    await db.batch([
      stmt(db, "UPDATE sends SET status = 'sending', started_at = ? WHERE id = ? AND status = 'scheduled'", now(), send.id),
      // Audience snapshot: active people who are not suppressed. One statement, so it cannot half-run.
      stmt(db, `INSERT OR IGNORE INTO send_recipients (send_id, person_id, email_norm, token, status)
        SELECT ?, id, email_norm, token, 'queued' FROM people WHERE status = 'active' AND email_norm NOT IN (SELECT email_norm FROM suppressions)`, send.id),
      ...urls.map((u, i) => stmt(db, 'INSERT OR IGNORE INTO send_links (send_id, idx, url) VALUES (?, ?, ?)', send.id, i, u)),
    ]);
    await audit(db, 'cron', 'send.start', 'send', send.id, { slug: send.issue_slug });
  }
  for (const send of await all(db, "SELECT * FROM sends WHERE status = 'sending' ORDER BY id LIMIT 2")) out.push({ id: send.id, ...(await processSend(env, send)) });
  return out;
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
  const pick = await pickProvider(env, 0);
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
<p>Please confirm that you want to receive ${esc(site.name)}, ${esc(site.tagline.toLowerCase())}, ${esc(site.send_slot_label)}.</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#c3142d;color:#fff;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:4px">Confirm my subscription</a></p>
<p style="font-size:13px;color:#5f5e58">If you did not ask for this, ignore this email and you will not hear from us again.</p>
<p style="font-size:12px;color:#5f5e58">${esc(site.name)} · ${esc(site.postal_address)}</p></div>`;
  const text = `Please confirm that you want to receive ${site.name}.\n\nConfirm: ${url}\n\nIf you did not ask for this, ignore this email.\n\n${site.name} · ${site.postal_address}`;
  return sendTransactional(env, person.email_norm, `Confirm your subscription to ${site.name}`, html, text);
}
