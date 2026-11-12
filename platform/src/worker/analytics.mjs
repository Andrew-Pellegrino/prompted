// Owner dashboard queries and historical-metrics import.
// Two eras are kept apart on purpose: "beehiiv" (imported, frozen) and "platform" (measured here).
import { all, first, stmt, now, audit, HttpError, listIssues } from './core.mjs';
import { quotas } from './sending.mjs';

export const METRIC_NOTES = {
  opens: 'Opens are counted when a tracking image loads. Apple Mail Privacy Protection and corporate mail scanners load images automatically, and some readers block them, so open figures are approximate in both eras.',
  clicks: 'Clicks include automated link scanners unless marked "verified" (beehiiv era only). Platform-era clicks are raw redirect hits.',
  eras: 'beehiiv-era figures are imported exactly as beehiiv reported them and are never recalculated. Platform-era figures are computed from this database. The two are not strictly comparable.',
  growth: 'beehiiv-era growth before the migration date is only as complete as the imported series.',
};

export async function dashboard(env) {
  const db = env.DB;
  const [byStatus, bySource, byCampaign, byOrg, recent, growth, sends, imports, issueRows, sup] = await Promise.all([
    all(db, 'SELECT status, COUNT(*) AS n FROM people GROUP BY status'),
    all(db, "SELECT COALESCE(source, '(unknown)') AS source, COUNT(*) AS n, SUM(status = 'active') AS active FROM people GROUP BY source ORDER BY n DESC LIMIT 25"),
    all(db, "SELECT utm_campaign AS campaign, utm_source AS source, utm_medium AS medium, COUNT(*) AS n, SUM(status = 'active') AS active FROM people WHERE utm_campaign IS NOT NULL GROUP BY utm_campaign, utm_source, utm_medium ORDER BY n DESC LIMIT 25"),
    all(db, "SELECT o.name AS org, COUNT(*) AS n, SUM(p.status = 'active') AS active, SUM(p.status = 'prospective') AS prospective FROM memberships m JOIN organizations o ON o.id = m.org_id JOIN people p ON p.id = m.person_id GROUP BY o.name ORDER BY n DESC"),
    all(db, "SELECT substr(at, 1, 10) AS day, SUM(to_status = 'active') AS activated, SUM(to_status = 'unsubscribed') AS unsubscribed, SUM(to_status IN ('bounced','complained')) AS lost FROM status_history WHERE at >= ? GROUP BY day ORDER BY day", new Date(Date.now() - 90 * 864e5).toISOString()),
    all(db, 'SELECT day, era, active, new_subscribers, unsubscribes FROM growth_series ORDER BY day'),
    all(db, "SELECT id, issue_slug, kind, status, scheduled_at, started_at, finished_at, totals FROM sends WHERE kind = 'issue' ORDER BY id DESC LIMIT 20"),
    all(db, 'SELECT id, filename, source_label, target_status, era, totals, actor, created_at FROM import_batches ORDER BY id DESC LIMIT 10'),
    all(db, 'SELECT * FROM issue_metrics'),
    first(db, 'SELECT COUNT(*) AS n FROM suppressions'),
  ]);
  const platform = await all(db, `SELECT s.issue_slug, COUNT(*) AS recipients, SUM(r.status IN ('sent','delivered')) AS delivered, SUM(r.status = 'bounced') AS bounces,
      SUM(r.status = 'failed') AS failed, SUM(r.opens > 0) AS unique_opens, SUM(r.opens) AS opens, SUM(r.clicks > 0) AS unique_clicks, SUM(r.clicks) AS clicks
    FROM send_recipients r JOIN sends s ON s.id = r.send_id WHERE s.kind = 'issue' GROUP BY s.issue_slug`);
  const unsubBySend = await all(db, "SELECT send_id, COUNT(*) AS n FROM delivery_events WHERE type = 'unsubscribe' AND send_id IS NOT NULL GROUP BY send_id");
  const issues = await listIssues(env);
  const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
  return {
    generated_at: now(),
    audience: { ...counts, total: byStatus.reduce((a, r) => a + r.n, 0), suppression_list: sup.n },
    sources: bySource, campaigns: byCampaign, organizations: byOrg,
    recent_changes: recent, growth_series: growth,
    issues: issues.map((i) => ({ number: i.number, slug: i.slug, week: i.week.label,
      beehiiv: issueRows.find((m) => m.issue_slug === i.slug && m.era === 'beehiiv') || null,
      platform: platform.find((m) => m.issue_slug === i.slug) || null })).reverse(),
    sends: sends.map((s) => ({ ...s, totals: JSON.parse(s.totals), unsubscribes: unsubBySend.find((u) => u.send_id === s.id)?.n || 0 })),
    imports: imports.map((b) => ({ ...b, totals: JSON.parse(b.totals) })),
    gmail_health: JSON.parse((await first(db, "SELECT value FROM settings WHERE key = 'gmail_health'"))?.value || 'null'),
    quotas: await quotas(env), send_mode: env.SEND_MODE === 'live' ? 'live' : 'dryrun',
    notes: METRIC_NOTES,
  };
}

/**
 * Import historical per-issue metrics exactly as exported from beehiiv.
 * Accepts { posts: [{ post_id, email: {...}, web: {...} }] } (the beehiiv stats shape).
 * Idempotent: a later import of the same post replaces the earlier snapshot.
 */
export async function importBeehiivMetrics(env, payload, actor) {
  const posts = payload?.posts;
  if (!Array.isArray(posts) || !posts.length) throw new HttpError(400, 'Expected { "posts": [ ... ] } in beehiiv post-stats format.');
  const issues = await listIssues(env);
  const byPost = new Map(issues.map((i) => [i.source.post_id, i.slug]));
  const stmts = [], unmatched = [];
  for (const p of posts) {
    const slug = byPost.get(p.post_id);
    if (!slug) { unmatched.push(p.post_id); continue; }
    const e = p.email || {}, w = p.web || {};
    const sent = (e.recipients || 0) > 0;
    stmts.push(stmt(env.DB, `INSERT INTO issue_metrics (issue_slug, era, recipients, delivered, opens, unique_opens, clicks, unique_clicks, verified_clicks, unique_verified_clicks, unsubscribes, spam_reports, bounces, web_views, web_clicks, captured_at, note)
      VALUES (?, 'beehiiv', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_slug, era) DO UPDATE SET recipients=excluded.recipients, delivered=excluded.delivered, opens=excluded.opens, unique_opens=excluded.unique_opens, clicks=excluded.clicks, unique_clicks=excluded.unique_clicks,
        verified_clicks=excluded.verified_clicks, unique_verified_clicks=excluded.unique_verified_clicks, unsubscribes=excluded.unsubscribes, spam_reports=excluded.spam_reports, bounces=excluded.bounces, web_views=excluded.web_views, web_clicks=excluded.web_clicks, captured_at=excluded.captured_at, note=excluded.note`,
      slug, e.recipients ?? null, e.delivered ?? null, e.opens ?? null, e.unique_opens ?? null, e.clicks ?? null, e.unique_clicks ?? null, e.verified_clicks ?? null, e.unique_verified_clicks ?? null,
      e.unsubscribes ?? null, e.spam_reports ?? null, sent && e.delivered != null ? e.recipients - e.delivered : null, w.views ?? null, w.clicks ?? null, payload.captured_at || now(),
      sent ? 'Emailed through beehiiv.' : 'Not emailed through beehiiv (archive back-fill); only web figures exist.'));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await audit(env.DB, actor, 'metrics.import', 'issue_metrics', null, { imported: stmts.length, unmatched: unmatched.length });
  return { imported: stmts.length, unmatched };
}

/** Import a growth series: { series: [{ day, active?, new_subscribers?, unsubscribes? }], era? }. */
export async function importGrowth(env, payload, actor) {
  const rows = payload?.series;
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'Expected { "series": [ { "day": "YYYY-MM-DD", ... } ] }.');
  const era = payload.era === 'platform' ? 'platform' : 'beehiiv';
  const stmts = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day || '')).map((r) => stmt(env.DB, `INSERT INTO growth_series (day, era, active, new_subscribers, unsubscribes, note) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, era) DO UPDATE SET active=excluded.active, new_subscribers=excluded.new_subscribers, unsubscribes=excluded.unsubscribes, note=excluded.note`, r.day, era, r.active ?? null, r.new_subscribers ?? null, r.unsubscribes ?? null, r.note ?? null));
  for (let i = 0; i < stmts.length; i += 400) await env.DB.batch(stmts.slice(i, i + 400));
  await audit(env.DB, actor, 'growth.import', 'growth_series', null, { rows: stmts.length, era });
  return { imported: stmts.length, era };
}

const BACKUP_TABLES = ['people', 'status_history', 'suppressions', 'organizations', 'memberships', 'person_tags', 'interactions', 'attribution_events', 'import_batches', 'import_rows',
  'sends', 'send_recipients', 'send_links', 'engagement_events', 'engagement_summaries', 'webhook_messages', 'delivery_events', 'provider_usage', 'issue_metrics', 'growth_series', 'placement_tests', 'audit_log', 'settings'];

/** Full logical backup as JSON (all tables). The file contains private data: store it privately. */
export async function fullBackup(env) {
  const out = { schema: 'prompted-backup-1', created_at: now(), tables: {} };
  for (const t of BACKUP_TABLES) out.tables[t] = await all(env.DB, `SELECT * FROM ${t}`);
  out.tables.settings = out.tables.settings.filter((r) => !/token|secret/i.test(r.key)); // credentials never leave in a backup
  return out;
}

/** Restore a backup into an EMPTY database only (never merges over live data). */
export async function restoreBackup(env, backup, actor) {
  if (backup?.schema !== 'prompted-backup-1') throw new HttpError(400, 'Not a Prompted backup file.');
  if ((await first(env.DB, 'SELECT COUNT(*) AS n FROM people')).n > 0) throw new HttpError(409, 'Restore only runs against an empty database.');
  const stmts = [];
  for (const t of BACKUP_TABLES) for (const row of backup.tables[t] || []) {
    // The audit log of the target already has entries (the restore login); keep its own ids.
    const cols = Object.keys(row).filter((c) => !(t === 'audit_log' && c === 'id'));
    if (!cols.every((c) => /^[a-z_][a-z0-9_]*$/.test(c))) throw new HttpError(400, `Bad column name in ${t}.`);
    stmts.push(stmt(env.DB, `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c])));
  }
  for (let i = 0; i < stmts.length; i += 400) await env.DB.batch(stmts.slice(i, i + 400));
  await audit(env.DB, actor, 'backup.restore', null, null, { statements: stmts.length });
  return { restored_rows: stmts.length };
}
