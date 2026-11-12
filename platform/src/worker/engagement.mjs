// First-party open and click tracking, and the engagement reports built from it.
//
// Privacy: tracking URLs carry only a random per-send tracking id (send_recipients.track_id), never the
// subscriber's token or address. Events store the time, the link and a coarse "agent" class; no IP
// address and no raw user agent. Reports are aggregates; small audience segments are not shown.
// Reliability: a tracking failure never breaks a link or the open image. A click is only ever forwarded
// to a URL stored for that send from the approved issue and template, so there is no open redirect.
import { all, first, run, now } from './core.mjs';

export const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
export const TRACK_RE = /^[a-f0-9]{24}$/;
const MAX_EVENTS_PER_RECIPIENT = 60; // a scanner hammering one email cannot fill the table

// ---------- who is asking ----------
const SCANNER_UA = /bot\b|crawl|spider|scan|preview|python|curl|wget|httpclient|go-http|java\/|okhttp|axios|node-fetch|undici|headless|phantom|barracuda|mimecast|proofpoint|fireeye|zscaler|symantec|trend ?micro|sophos|ironport|forcepoint|safelinks|microsoft office protection|linkcheck|validator|monitor|libwww|feedfetcher/i;

/**
 * Coarse class of the requester, from the request itself. Nothing identifying is kept.
 *  browser            an ordinary browser or mail app
 *  gmail_proxy        Gmail fetching images when a reader opens the message (counts as a likely open)
 *  apple_privacy      Apple Mail Privacy Protection, which preloads images whether or not anyone reads
 *  microsoft_network  Microsoft's network: Outlook image proxy (opens) or Defender link checks (clicks)
 *  scanner            a security scanner, script or empty user agent
 *  head               a HEAD request (link checkers; browsers do not do this for a click)
 */
export function classifyAgent(request, kind) {
  if (request.method === 'HEAD') return 'head';
  const ua = request.headers.get('user-agent') || '';
  const asn = request.cf?.asn;
  if (/GoogleImageProxy|ggpht\.com/i.test(ua)) return 'gmail_proxy';
  if (!ua || SCANNER_UA.test(ua)) return 'scanner';
  if (kind === 'open' && (asn === 714 || asn === 6185)) return 'apple_privacy';
  if (asn === 8075) return 'microsoft_network';
  return 'browser';
}

// ---------- recording (public routes) ----------
const pixel = () => new Response(GIF, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, private', 'x-robots-tag': 'noindex' } });

/** /o/<track>.gif : always answers with the image, whatever happens to the recording. */
export async function openRoute(request, env, trackId) {
  try {
    const r = await first(env.DB, 'SELECT send_id, opens FROM send_recipients WHERE track_id = ?', trackId);
    if (r && r.opens < MAX_EVENTS_PER_RECIPIENT) {
      const at = now();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO engagement_events (send_id, track_id, kind, link_idx, at, agent) VALUES (?, ?, 'open', NULL, ?, ?)").bind(r.send_id, trackId, at, classifyAgent(request, 'open')),
        env.DB.prepare('UPDATE send_recipients SET opens = opens + 1, first_opened_at = COALESCE(first_opened_at, ?) WHERE track_id = ?').bind(at, trackId),
      ]);
    }
  } catch (e) { console.error('open not recorded', e?.message); }
  return pixel();
}

const safeTarget = (url) => { try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; } };
const redirect = (url) => new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' } });

/**
 * /r/<track>/<idx> : forwards to the stored link. Recording happens only after the destination is known
 * and its failure is ignored. If the database cannot be read at all, the reader lands on the archive
 * rather than an error page. Unknown ids or link numbers go to the home page, never to a caller-chosen URL.
 */
export async function clickRoute(request, env, trackId, idx, siteUrl) {
  let row;
  try {
    row = await first(env.DB, 'SELECT r.send_id, r.clicks, l.url FROM send_recipients r JOIN send_links l ON l.send_id = r.send_id AND l.idx = ? WHERE r.track_id = ?', idx, trackId);
  } catch (e) { console.error('click lookup failed', e?.message); return redirect(siteUrl + '/issues/'); }
  const target = row && safeTarget(row.url);
  if (!target) return redirect(siteUrl + '/');
  if (row.clicks < MAX_EVENTS_PER_RECIPIENT) {
    try {
      const at = now();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO engagement_events (send_id, track_id, kind, link_idx, at, agent) VALUES (?, ?, 'click', ?, ?, ?)").bind(row.send_id, trackId, idx, at, classifyAgent(request, 'click')),
        env.DB.prepare('UPDATE send_links SET clicks = clicks + 1 WHERE send_id = ? AND idx = ?').bind(row.send_id, idx),
        env.DB.prepare('UPDATE send_recipients SET clicks = clicks + 1, first_clicked_at = COALESCE(first_clicked_at, ?) WHERE track_id = ?').bind(at, trackId),
      ]);
    } catch (e) { console.error('click not recorded', e?.message); }
  }
  return redirect(target);
}

/** Old-style links from before tracking ids (/r/<send>/<idx>/<token>): forwarded, never recorded. */
export async function legacyClickRoute(env, sendId, idx, siteUrl) {
  let row = null;
  try { row = await first(env.DB, 'SELECT url FROM send_links WHERE send_id = ? AND idx = ?', sendId, idx); } catch { /* fall through */ }
  const target = row && safeTarget(row.url);
  return redirect(target || siteUrl + '/');
}
export const legacyOpenRoute = () => pixel();

// ---------- reports ----------
// "Estimated human" is a heuristic, shown next to the raw figures, never instead of them:
//  - opens: from a browser, mail app, Gmail's or Outlook's image proxy, and at least 15 seconds after
//    the message was sent. Apple's privacy preloads, scanners and link checkers are excluded.
//  - clicks: from a browser, at least 15 seconds after sending, and not part of a burst in which the same
//    email had 3 or more different links opened within 10 seconds (what scanners do).
//  - a likely-human click also counts as a likely-human open (the reader must have opened it).
export const HUMAN_RULES = {
  min_seconds_after_send: 15, burst_links: 3, burst_seconds: 10,
  open_agents: ['browser', 'gmail_proxy', 'microsoft_network'], click_agents: ['browser'],
};
export const MIN_SEGMENT = 5; // segments with fewer recipients are not broken out (they could point at a person)

const DELIVERED = "('sent','delivered','bounced','complained')";
const EVENTS = `
  SELECT e.kind, e.link_idx, e.track_id, e.agent,
    CASE WHEN e.kind = 'open' THEN
      (e.agent IN ('browser','gmail_proxy','microsoft_network') AND (r.sent_at IS NULL OR (julianday(e.at) - julianday(r.sent_at)) * 86400 >= ${HUMAN_RULES.min_seconds_after_send}))
    ELSE
      (e.agent = 'browser' AND (r.sent_at IS NULL OR (julianday(e.at) - julianday(r.sent_at)) * 86400 >= ${HUMAN_RULES.min_seconds_after_send})
        AND (SELECT COUNT(DISTINCT e2.link_idx) FROM engagement_events e2 WHERE e2.track_id = e.track_id AND e2.kind = 'click'
             AND abs(julianday(e2.at) - julianday(e.at)) * 86400 <= ${HUMAN_RULES.burst_seconds}) < ${HUMAN_RULES.burst_links})
    END AS human
  FROM engagement_events e JOIN send_recipients r ON r.track_id = e.track_id WHERE e.send_id = ?`;

const SEGMENT_SQL = (field) => `
  WITH ev AS (${EVENTS}),
  per AS (SELECT track_id, MAX(kind = 'open') AS o, MAX(kind = 'click') AS c, MAX(human) AS ho, MAX(kind = 'click' AND human) AS hc FROM ev GROUP BY track_id),
  rec AS (SELECT r.track_id, ${field} AS seg FROM send_recipients r WHERE r.send_id = ? AND r.status IN ${DELIVERED})
  SELECT rec.seg AS segment, COUNT(*) AS recipients, SUM(COALESCE(per.o, 0) OR COALESCE(per.c, 0)) AS raw_openers, SUM(COALESCE(per.ho, 0)) AS human_openers,
    SUM(COALESCE(per.c, 0)) AS raw_clickers, SUM(COALESCE(per.hc, 0)) AS human_clickers
  FROM rec LEFT JOIN per ON per.track_id = rec.track_id WHERE rec.seg IS NOT NULL GROUP BY rec.seg ORDER BY recipients DESC`;

const DOMAIN_GROUP = `CASE
  WHEN substr(r.email_norm, instr(r.email_norm, '@') + 1) = 'miamioh.edu' THEN 'Miami University addresses'
  WHEN substr(r.email_norm, instr(r.email_norm, '@') + 1) LIKE '%.edu' THEN 'Other university addresses'
  WHEN substr(r.email_norm, instr(r.email_norm, '@') + 1) IN ('gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','icloud.com','me.com','mac.com','yahoo.com','aol.com','proton.me','protonmail.com')
    THEN 'Personal email (Gmail, Outlook, iCloud, Yahoo and similar)'
  ELSE 'Other addresses' END`;

const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

/** Full engagement report for one send. Aggregates only: no addresses, tokens or tracking ids. */
export async function engagementReport(db, sendId) {
  const saved = await first(db, 'SELECT data FROM engagement_summaries WHERE send_id = ?', sendId);
  if (saved) return { ...JSON.parse(saved.data), from_saved_summary: true };
  const base = await first(db, `SELECT COUNT(*) AS recipients, SUM(status IN ${DELIVERED}) AS sent, SUM(status = 'delivered') AS delivered_confirmed FROM send_recipients WHERE send_id = ?`, sendId);
  const t = await first(db, `WITH ev AS (${EVENTS}) SELECT
      SUM(kind = 'open') AS raw_opens, COUNT(DISTINCT CASE WHEN kind = 'open' THEN track_id END) AS raw_unique_opens,
      SUM(kind = 'click') AS raw_clicks, COUNT(DISTINCT CASE WHEN kind = 'click' THEN track_id END) AS raw_unique_clicks,
      COUNT(DISTINCT CASE WHEN human THEN track_id END) AS human_unique_opens,
      SUM(kind = 'click' AND human) AS human_clicks, COUNT(DISTINCT CASE WHEN kind = 'click' AND human THEN track_id END) AS human_unique_clicks,
      SUM(kind = 'open' AND agent = 'apple_privacy') AS apple_privacy_opens, SUM(agent IN ('scanner','head')) AS scanner_events,
      COUNT(DISTINCT CASE WHEN kind = 'click' AND NOT human THEN track_id END) AS machine_click_recipients
    FROM ev`, sendId);
  const sent = base.sent || 0;
  const links = await all(db, `WITH ev AS (${EVENTS})
    SELECT l.idx, l.url, l.label, l.kind, COUNT(ev.track_id) AS raw_clicks, COUNT(DISTINCT ev.track_id) AS raw_unique,
      COUNT(DISTINCT CASE WHEN ev.human THEN ev.track_id END) AS human_unique
    FROM send_links l LEFT JOIN ev ON ev.kind = 'click' AND ev.link_idx = l.idx WHERE l.send_id = ? GROUP BY l.idx ORDER BY human_unique DESC, raw_clicks DESC, l.idx`, sendId, sendId);
  const shape = (rows) => rows.map((s) => (s.recipients < MIN_SEGMENT
    ? { segment: s.segment, recipients: `fewer than ${MIN_SEGMENT}`, hidden: true }
    : { segment: s.segment, recipients: s.recipients, raw_open_rate: rate(s.raw_openers, s.recipients), human_open_rate: rate(s.human_openers, s.recipients), raw_click_rate: rate(s.raw_clickers, s.recipients), human_click_rate: rate(s.human_clickers, s.recipients) }));
  const byDomain = shape(await all(db, SEGMENT_SQL(DOMAIN_GROUP), sendId, sendId));
  const byTag = shape(await all(db, SEGMENT_SQL('(SELECT GROUP_CONCAT(tag, \', \') FROM (SELECT tag FROM person_tags WHERE person_id = r.person_id ORDER BY tag))'), sendId, sendId));
  const byOrg = shape(await all(db, SEGMENT_SQL('(SELECT GROUP_CONCAT(name, \', \') FROM (SELECT o.name FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.person_id = r.person_id ORDER BY o.name))'), sendId, sendId));
  return {
    sent, delivered_confirmed: base.delivered_confirmed || 0,
    raw: { opens: t.raw_opens || 0, unique_opens: t.raw_unique_opens || 0, open_rate: rate(t.raw_unique_opens, sent), clicks: t.raw_clicks || 0, unique_clicks: t.raw_unique_clicks || 0, click_rate: rate(t.raw_unique_clicks, sent) },
    estimated_human: { unique_opens: t.human_unique_opens || 0, open_rate: rate(t.human_unique_opens, sent), clicks: t.human_clicks || 0, unique_clicks: t.human_unique_clicks || 0, click_rate: rate(t.human_unique_clicks, sent), click_to_open_rate: rate(t.human_unique_clicks, t.human_unique_opens) },
    machine_signals: { apple_privacy_opens: t.apple_privacy_opens || 0, scanner_or_checker_events: t.scanner_events || 0, recipients_with_machine_like_clicks: t.machine_click_recipients || 0 },
    links: links.map((l) => ({ idx: l.idx, url: l.url, label: l.label, kind: l.kind, raw_clicks: l.raw_clicks, raw_unique: l.raw_unique, human_unique: l.human_unique })),
    segments: { by_address_type: byDomain, by_tag: byTag, by_organization: byOrg, min_size: MIN_SEGMENT },
    rules: HUMAN_RULES,
  };
}

/** One row per sent issue for trend charts (latest first). */
export async function engagementTrend(db, limit = 26) {
  const sends = await all(db, "SELECT id, issue_slug, finished_at, started_at FROM sends WHERE kind = 'issue' AND status IN ('sent','sending') ORDER BY id DESC LIMIT ?", limit);
  const out = [];
  for (const s of sends) {
    const r = await engagementReport(db, s.id);
    out.push({ send_id: s.id, issue_slug: s.issue_slug, sent_at: s.started_at, sent: r.sent, raw_open_rate: r.raw.open_rate, human_open_rate: r.estimated_human.open_rate, raw_click_rate: r.raw.click_rate, human_click_rate: r.estimated_human.click_rate });
  }
  return out;
}

/**
 * Retention: per-event rows are kept EVENT_RETENTION_DAYS (default 90). Before a send's events are
 * deleted its report is saved, so issue-level figures survive. Per-recipient open and click counters are
 * cleared after RECIPIENT_ENGAGEMENT_DAYS (default 400). Runs from cron; sends nothing.
 */
export async function pruneEngagement(env) {
  const db = env.DB, days = Number(env.EVENT_RETENTION_DAYS || 90), recDays = Number(env.RECIPIENT_ENGAGEMENT_DAYS || 400);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const old = await all(db, 'SELECT DISTINCT send_id FROM engagement_events WHERE at < ? LIMIT 5', cutoff);
  for (const { send_id: id } of old) {
    if (!(await first(db, 'SELECT 1 AS x FROM engagement_summaries WHERE send_id = ?', id))) {
      const report = await engagementReport(db, id);
      await run(db, 'INSERT OR IGNORE INTO engagement_summaries (send_id, computed_at, data) VALUES (?, ?, ?)', id, now(), JSON.stringify(report));
    }
    await run(db, 'DELETE FROM engagement_events WHERE send_id = ?', id);
  }
  const recCutoff = new Date(Date.now() - recDays * 86400000).toISOString();
  await run(db, 'UPDATE send_recipients SET opens = 0, clicks = 0, first_opened_at = NULL, first_clicked_at = NULL WHERE (opens > 0 OR clicks > 0) AND send_id IN (SELECT id FROM sends WHERE started_at < ?)', recCutoff);
  return { pruned_sends: old.length };
}
