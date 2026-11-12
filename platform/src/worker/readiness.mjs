// Cutover readiness: one read-only check that turns the go/no-go list into live answers.
// It sends nothing and changes nothing. "blocker" items must all pass before an approved cutover.
import { all, first, siteConfig } from './core.mjs';
import { sesStatus } from './ses.mjs';
import { checkDomain } from './dnscheck.mjs';
import { withMailSettings, quotas } from './sending.mjs';

const item = (group, name, ok, detail, level = 'blocker') => ({ group, name, ok: !!ok, level, detail });

export async function cutoverReadiness(env) {
  const db = env.DB, site = await siteConfig(env), out = [];
  const ses = await sesStatus(env, site).catch((e) => ({ configured: false, next: String(e.message || e) }));
  out.push(item('Sender', 'Amazon SES production access granted', ses.production_access, ses.production_access ? `${ses.quota.per_day} a day, ${ses.quota.per_second} a second` : 'still in the sandbox (200 a day, verified recipients only)'));
  out.push(item('Sender', 'Daily SES limit covers the whole list with room', ses.quota && ses.quota.per_day >= 2 * ((await first(db, "SELECT COUNT(*) AS n FROM people WHERE status = 'active'")).n || 1), ses.quota ? `${ses.quota.per_day} a day` : 'unknown'));
  out.push(item('Sender', 'Domain verified at Amazon (DKIM, MAIL FROM)', ses.domain && ses.domain.verified && ses.domain.dkim === 'SUCCESS' && ses.domain.mail_from_status === 'SUCCESS', ses.domain ? `${ses.domain.dkim}, ${ses.domain.mail_from_status}` : 'unknown'));
  out.push(item('Sender', 'Bounce and complaint reports connected (signed SNS)', ses.reports_connected, ses.reports ? `${ses.reports.received} reports received` : 'unknown'));
  out.push(item('Sender', 'Amazon Auto Validation off', ses.auto_validation && ses.auto_validation.active === false, ses.auto_validation ? String(ses.auto_validation.active) : 'unknown'));
  out.push(item('Sender', 'Amazon open and click tracking off', ses.vdm_engagement_tracking !== 'ENABLED' && !(ses.reports && ses.reports.tracking_seen_at), `VDM ${ses.vdm_engagement_tracking}`));
  out.push(item('Sender', 'Bulk sending on', env.SES_BULK === 'on', env.SES_BULK === 'on' ? 'on' : 'off (needs ses:SendBulkTemplatedEmail on the IAM key)'));
  let dns = null;
  try { dns = await checkDomain(String(env.FROM_EMAIL || '').split('@')[1] || 'readprompted.org'); } catch { /* reported below */ }
  out.push(item('Sender', 'SPF, DKIM, DMARC and MX published', dns && !dns.findings.some((f) => f.level === 'error'), dns ? dns.findings.map((f) => `${f.item} ${f.level}`).join(', ') : 'DNS check failed'));
  out.push(item('Compliance', 'Postal address in the footer', !/TODO|placeholder|not a real address|preview only/i.test(site.postal_address), 'set as a Worker secret'));
  const counts = Object.fromEntries((await all(db, 'SELECT status, COUNT(*) AS n FROM people GROUP BY status')).map((r) => [r.status, r.n]));
  const lastImport = await first(db, "SELECT created_at, source_label, totals FROM import_batches WHERE era = 'beehiiv' AND source_label LIKE 'beehiiv%' ORDER BY id DESC LIMIT 1");
  const ageH = lastImport ? (Date.now() - Date.parse(lastImport.created_at)) / 3600000 : null;
  out.push(item('Audience', 'Ledger imported from beehiiv within the last 24 hours', ageH !== null && ageH <= 24, lastImport ? `${lastImport.source_label}, ${Math.round(ageH)} h ago; now ${JSON.stringify(counts)}` : 'no beehiiv import'));
  out.push(item('Audience', 'Suppression list loaded', (await first(db, 'SELECT COUNT(*) AS n FROM suppressions')).n >= (counts.unsubscribed || 0) + (counts.bounced || 0) + (counts.complained || 0), `${(await first(db, 'SELECT COUNT(*) AS n FROM suppressions')).n} suppressed addresses`));
  const placements = await all(db, "SELECT inbox, result FROM placement_tests WHERE sender LIKE '%readprompted.org%' OR sender LIKE '%ses%' ORDER BY id DESC");
  const groups = ['Miami', 'Gmail', 'Outlook', 'iCloud'];
  const seen = groups.map((g) => [g, placements.find((p) => p.inbox.toLowerCase().includes(g.toLowerCase()))]);
  out.push(item('Deliverability', 'Inbox placement proven for Miami, Gmail, Outlook and iCloud from the domain', seen.every(([, p]) => p && p.result === 'inbox'), seen.map(([g, p]) => `${g}: ${p ? p.result : 'not tested'}`).join(', ')));
  const env2 = await withMailSettings(env), q = await quotas(env2);
  out.push(item('Switches', 'Audience lock (AUDIENCE_SENDING)', true, env.AUDIENCE_SENDING === 'enabled' ? 'ENABLED: the real audience can be sent' : 'locked: the audience can only get dry runs', 'info'));
  out.push(item('Switches', 'Sending mode and site mode', true, `SEND_MODE=${env.SEND_MODE || 'dryrun'}, SITE_ENV=${env.SITE_ENV}, audience chain ${q.map((x) => x.name).join(' > ')}`, 'info'));
  out.push(item('Switches', 'First-party tracking', true, `opens ${env.TRACK_OPENS === 'true' ? 'on' : 'off'}, clicks ${env.TRACK_CLICKS === 'true' ? 'on' : 'off'}`, 'info'));
  const blockers = out.filter((i) => i.level === 'blocker' && !i.ok);
  return { checked_at: new Date().toISOString(), go: blockers.length === 0, blockers: blockers.length, items: out };
}
