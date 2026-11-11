// CSV import: preview -> commit. Deduplicates, honours suppression, never re-activates anyone,
// and is idempotent (re-running the same file changes nothing).
import { parseCsvObjects } from '../lib/csv.mjs';
import { all, first, stmt, now, sha256, audit, HttpError } from './core.mjs';
import { normalizeEmail, validEmail, personInsertStatements, enrichStatements } from './people.mjs';

// Column auto-mapping: header (lower-cased, punctuation stripped) -> field.
const ALIASES = {
  email: ['email', 'emailaddress', 'e-mail', 'subscriberemail'],
  first_name: ['firstname', 'first', 'givenname'],
  last_name: ['lastname', 'last', 'surname', 'familyname'],
  name: ['name', 'fullname'],
  status: ['status', 'subscriptionstatus', 'beehiivstatus'],
  subscribed_at: ['subscribedat', 'subscribedon', 'subscribedate', 'created', 'createdat', 'signupdate'],
  unsubscribed_at: ['unsubscribedat', 'unsubscribedon', 'unsubscribedate'],
  source: ['source', 'acquisitionsource', 'originalsource'],
  utm_source: ['utmsource'], utm_medium: ['utmmedium'], utm_campaign: ['utmcampaign'], utm_content: ['utmcontent'], utm_term: ['utmterm'],
  referrer: ['referrer', 'referringsite', 'referringurl'],
  tags: ['tags', 'tag'],
  organizations: ['organizations', 'organization', 'org', 'rosterorganizations', 'orgs'],
  role: ['role', 'roles', 'position'],
  institution_id: ['institutionid', 'miamiuniqueid', 'uniqueid', 'studentid'],
  member_loa: ['memberloa', 'awememberloa', 'loa'],
  email_verification: ['emailverification', 'verification', 'emailverified'],
  notes: ['notes', 'note', 'crmnotes'],
  external_id: ['subscriptionid', 'beehiivid', 'id'],
};
const key = (h) => h.toLowerCase().replace(/[^a-z0-9-]/g, '');
export function autoMap(headers) {
  const map = {};
  for (const h of headers) for (const [field, names] of Object.entries(ALIASES)) if (names.includes(key(h)) && !Object.values(map).includes(field)) map[h] = field;
  return map;
}

const truthy = (v) => /^(1|true|yes|y|x|loa|member loa)$/i.test(String(v || '').trim());
const list = (v) => String(v || '').split(/[;|]/).map((x) => x.trim()).filter(Boolean);
const isoOrNull = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };

// Status words from other systems -> ours. Unknown words fall back to the safest reading.
const STATUS_MAP = { active: 'active', subscribed: 'active', inactive: 'unsubscribed', unsubscribed: 'unsubscribed', pending: 'pending', validating: 'pending',
  needs_attention: 'bounced', bounced: 'bounced', undeliverable: 'bounced', complained: 'complained', spam: 'complained', suppressed: 'suppressed', prospective: 'prospective' };

export const IMPORT_FIELDS = Object.keys(ALIASES);

function rowFields(rec, map) {
  const f = {}, custom = {};
  for (const [header, field] of Object.entries(map)) if (field && rec[header] !== undefined && rec[header] !== '') f[field] = rec[header];
  // Columns that are not mapped to a known field are kept, verbatim, as custom fields.
  for (const [header, value] of Object.entries(rec)) if (header !== '_row' && !map[header] && value !== '') custom[header] = value;
  f._custom = custom;
  if (f.name && !f.first_name) { const parts = f.name.trim().split(/\s+/); f.first_name = parts[0]; f.last_name = parts.slice(1).join(' ') || undefined; }
  return f;
}

/**
 * Classify every row. No writes.
 * opts: { mapping?, mode: 'audience'|'migration', target_status, source_label }
 */
export async function planImport(db, csvText, opts = {}) {
  const { headers, records } = parseCsvObjects(csvText);
  if (!headers.length) throw new HttpError(400, 'The file is empty.');
  if (records.length > 5000) throw new HttpError(400, 'Import files are limited to 5,000 rows.');
  // A mapping from the dashboard may only name known headers and known fields; "" means "keep as a custom field".
  const mapping = opts.mapping && Object.keys(opts.mapping).length
    ? Object.fromEntries(Object.entries(opts.mapping).filter(([h, field]) => headers.includes(h) && IMPORT_FIELDS.includes(field)))
    : autoMap(headers);
  const mode = opts.mode === 'migration' ? 'migration' : 'audience';
  // No recognisable email column: hand back the headers so the owner can choose one in the dashboard.
  if (!Object.values(mapping).includes('email')) return { headers, fields: IMPORT_FIELDS, mapping, mode, target_status: null, source_label: opts.source_label || 'import', totals: { rows: records.length }, rows: [], needs_mapping: true, sha256: await sha256(csvText) };
  const target = mode === 'audience' ? (opts.target_status || 'prospective') : null;
  if (mode === 'audience' && !['prospective', 'pending', 'active'].includes(target)) throw new HttpError(400, 'Target status must be prospective, pending or active.');

  const emails = [...new Set(records.map((r) => normalizeEmail(rowFields(r, mapping).email)).filter(Boolean))];
  const existing = new Map(), suppressed = new Map();
  for (let i = 0; i < emails.length; i += 90) {
    const chunk = emails.slice(i, i + 90), q = chunk.map(() => '?').join(',');
    for (const p of await all(db, `SELECT id, email_norm, status, first_name, last_name, institution_id FROM people WHERE email_norm IN (${q})`, ...chunk)) existing.set(p.email_norm, p);
    for (const s of await all(db, `SELECT email_norm, reason FROM suppressions WHERE email_norm IN (${q})`, ...chunk)) suppressed.set(s.email_norm, s.reason);
  }

  const seen = new Set();
  const rows = records.map((rec) => {
    const f = rowFields(rec, mapping);
    const email_norm = normalizeEmail(f.email);
    const base = { row: rec._row, email: email_norm };
    if (!email_norm) return { ...base, outcome: 'rejected', detail: 'no email address' };
    if (!validEmail(email_norm)) return { ...base, outcome: 'rejected', detail: 'invalid email address' };
    if (seen.has(email_norm)) return { ...base, outcome: 'duplicate_in_file', detail: 'same address appears earlier in this file' };
    seen.add(email_norm);
    const fields = {
      email: f.email.trim(), first_name: f.first_name, last_name: f.last_name, source: f.source || opts.source_label || 'import',
      utm_source: f.utm_source, utm_medium: f.utm_medium, utm_campaign: f.utm_campaign, utm_content: f.utm_content, utm_term: f.utm_term, referrer: f.referrer,
      institution_id: f.institution_id, member_loa: truthy(f.member_loa), notes: f.notes,
      email_verification: ['verified', 'inferred', 'unverified'].includes(String(f.email_verification || '').toLowerCase()) ? f.email_verification.toLowerCase() : 'unverified',
      tags: list(f.tags), memberships: list(f.organizations).map((org, i) => ({ org, role: list(f.role)[i] || (list(f.organizations).length === 1 ? f.role : null) || null })),
      subscribed_at: isoOrNull(f.subscribed_at), unsubscribed_at: isoOrNull(f.unsubscribed_at), created_at: isoOrNull(f.subscribed_at) || undefined,
      external_ids: f.external_id ? { [mode === 'migration' ? 'beehiiv' : 'import']: f.external_id } : {},
      custom: f._custom,
    };
    const fileStatus = STATUS_MAP[String(f.status || '').toLowerCase().replace(/\s+/g, '_')];
    const person = existing.get(email_norm), sup = suppressed.get(email_norm);
    if (mode === 'migration') {
      fields.status = fileStatus || (f.status ? 'suppressed' : 'active');
      if (f.status && !fileStatus) fields.status_reason = `unrecognised source status "${f.status}"`;
      if (fields.status === 'active' && sup) return { ...base, outcome: 'suppressed', detail: `on suppression list (${sup}); not activated`, fields: null };
      if (person) return { ...base, outcome: 'existing', detail: `already in database as ${person.status}; organizations and tags merged, status untouched`, fields, merge: true };
      return { ...base, outcome: 'new', detail: `migrated as ${fields.status}`, fields };
    }
    if (sup) return { ...base, outcome: 'suppressed', detail: `on suppression list (${sup}); skipped`, fields: null };
    if (person) {
      if (['unsubscribed', 'bounced', 'complained', 'suppressed'].includes(person.status)) return { ...base, outcome: 'suppressed', detail: `existing record is ${person.status}; skipped`, fields: null };
      return { ...base, outcome: 'existing', detail: `already ${person.status}; organizations and tags merged, status untouched`, fields, merge: true };
    }
    fields.status = target;
    return { ...base, outcome: 'new', detail: `will be added as ${target}`, fields };
  });
  const totals = rows.reduce((t, r) => ({ ...t, [r.outcome]: (t[r.outcome] || 0) + 1 }), { rows: rows.length });
  return { headers, fields: IMPORT_FIELDS, mapping, mode, target_status: target, source_label: opts.source_label || 'import', totals, rows, sha256: await sha256(csvText) };
}

/** Apply a plan. Requires an explicit consent attestation from the owner to add people as active. */
export async function commitImport(db, csvText, opts, actor) {
  const plan = await planImport(db, csvText, opts);
  if (plan.needs_mapping) throw new HttpError(400, 'Choose which column holds the email address before importing.');
  if (plan.mode === 'audience' && plan.target_status === 'active' && opts.consent_attested !== true)
    throw new HttpError(400, 'Adding people as active subscribers requires the owner to confirm that each person agreed to receive Prompted.');
  const dupe = await first(db, 'SELECT id, totals, created_at FROM import_batches WHERE sha256 = ? AND source_label = ? AND target_status = ?', plan.sha256, plan.source_label, plan.target_status || 'migration');
  if (dupe) return { already_imported: true, batch_id: dupe.id, created_at: dupe.created_at, totals: JSON.parse(dupe.totals) };

  const at = now();
  const batch = await db.prepare('INSERT INTO import_batches (filename, sha256, source_label, target_status, era, totals, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(opts.filename || null, plan.sha256, plan.source_label, plan.target_status || 'migration', plan.mode === 'migration' ? 'beehiiv' : 'platform', JSON.stringify(plan.totals), actor, at).run();
  const batchId = batch.meta.last_row_id;
  const statements = [];
  for (const r of plan.rows) {
    statements.push(stmt(db, 'INSERT INTO import_rows (batch_id, row_no, email_norm, outcome, detail) VALUES (?, ?, ?, ?, ?)', batchId, r.row, r.email || null, r.outcome, r.detail));
    if (r.outcome === 'new') statements.push(...personInsertStatements(db, r.fields, { actor, kind: plan.mode === 'migration' ? 'migration' : 'import', importBatchId: batchId }));
    if (r.outcome === 'existing') {
      statements.push(...enrichStatements(db, r.email, r.fields));
      // Fill blanks only; never overwrite what is already recorded.
      statements.push(stmt(db, `UPDATE people SET first_name = COALESCE(first_name, ?), last_name = COALESCE(last_name, ?), institution_id = COALESCE(institution_id, ?),
        member_loa = MAX(member_loa, ?), updated_at = ? WHERE email_norm = ?`, r.fields.first_name || null, r.fields.last_name || null, r.fields.institution_id || null, r.fields.member_loa ? 1 : 0, at, r.email));
      // A migration may only make an existing record more restrictive, never re-activate it.
      if (plan.mode === 'migration' && ['unsubscribed', 'bounced', 'complained', 'suppressed'].includes(r.fields.status)) {
        statements.push(stmt(db, `INSERT INTO status_history (person_id, from_status, to_status, reason, actor, at)
          SELECT id, status, ?, 'source system status', ?, ? FROM people WHERE email_norm = ? AND status IN ('active','pending','prospective')`, r.fields.status, actor, at, r.email));
        statements.push(stmt(db, "UPDATE people SET status = ?, unsubscribed_at = COALESCE(?, unsubscribed_at), updated_at = ? WHERE email_norm = ? AND status IN ('active','pending','prospective')", r.fields.status, r.fields.unsubscribed_at, at, r.email));
        statements.push(stmt(db, 'INSERT INTO suppressions (email_norm, reason, source, detail, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email_norm) DO NOTHING',
          r.email, r.fields.status === 'suppressed' ? 'manual' : r.fields.status, 'beehiiv-migration', null, at));
      }
    }
  }
  // D1 batches are transactional. Chunk to stay within statement limits per call.
  try {
    for (let i = 0; i < statements.length; i += 400) await db.batch(statements.slice(i, i + 400));
  } catch (e) {
    // Leave no half-recorded batch behind: rows already written are skipped as "existing" on the retry.
    await db.prepare('DELETE FROM import_batches WHERE id = ?').bind(batchId).run();
    throw e;
  }
  await audit(db, actor, 'import.commit', 'import_batch', batchId, { ...plan.totals, mode: plan.mode, target_status: plan.target_status, source_label: plan.source_label, consent_attested: opts.consent_attested === true });
  return { already_imported: false, batch_id: batchId, totals: plan.totals, rows: plan.rows.map(({ fields, merge, ...r }) => r) };
}

/**
 * Reconciliation report: compare a ledger exported from another system with this database.
 * Read-only. Lists counts by status on both sides and every address that differs.
 */
export async function reconcile(db, csvText, opts = {}) {
  const { headers, records } = parseCsvObjects(csvText);
  const mapping = opts.mapping && Object.keys(opts.mapping).length ? opts.mapping : autoMap(headers);
  if (!Object.values(mapping).includes('email')) throw new HttpError(400, 'No email column found.');
  const file = new Map(), invalid = [];
  for (const rec of records) {
    const f = rowFields(rec, mapping), e = normalizeEmail(f.email);
    if (!validEmail(e)) { invalid.push({ row: rec._row, email: e }); continue; }
    if (!file.has(e)) file.set(e, STATUS_MAP[String(f.status || 'active').toLowerCase().replace(/\s+/g, '_')] || 'suppressed');
  }
  const dbRows = await all(db, 'SELECT email_norm, status FROM people');
  const here = new Map(dbRows.map((r) => [r.email_norm, r.status]));
  const count = (it) => { const c = {}; for (const s of it) c[s] = (c[s] || 0) + 1; return c; };
  const missing = [...file].filter(([e]) => !here.has(e)).map(([email, status]) => ({ email, source_status: status }));
  const extra = [...here].filter(([e]) => !file.has(e)).map(([email, status]) => ({ email, status }));
  const mismatched = [...file].filter(([e, s]) => here.has(e) && here.get(e) !== s).map(([email, source_status]) => ({ email, source_status, status: here.get(email) }));
  // The one difference that must never exist: active here while the source says the person opted out or bounced.
  const dangerous = mismatched.filter((m) => m.status === 'active' && m.source_status !== 'active' && m.source_status !== 'pending');
  return { rows: records.length, unique_addresses: file.size, invalid, source_counts: count(file.values()), database_counts: count(here.values()),
    matching: file.size - missing.length - mismatched.length, missing_from_database: missing, only_in_database: extra, status_differs: mismatched, dangerous,
    in_agreement: !missing.length && !mismatched.length && !invalid.length };
}
