// Audience logic: identity, subscription state machine, suppression, attribution.
import { all, first, run, stmt, now, randomToken, audit, HttpError } from './core.mjs';

export const STATUSES = ['prospective', 'pending', 'active', 'unsubscribed', 'bounced', 'complained', 'suppressed'];
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const clip = (v, n = 200) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, n));

export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
export function validEmail(email) {
  const e = normalizeEmail(email);
  return e.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(e) && !e.includes('..');
}

export const suppression = (db, emailNorm) => first(db, 'SELECT * FROM suppressions WHERE email_norm = ?', emailNorm);

/** Record a suppression. An existing entry is kept (first reason wins) so history is never softened. */
export const suppress = (db, emailNorm, reason, source, detail = null) =>
  run(db, 'INSERT INTO suppressions (email_norm, reason, source, detail, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email_norm) DO NOTHING', emailNorm, reason, source, detail, now());

const SUPPRESS_ON = { unsubscribed: 'unsubscribed', bounced: 'bounced', complained: 'complained', suppressed: 'manual' };

/** Change a person's status, with history, timestamps and suppression side effects. */
export async function setStatus(db, person, to, { reason = null, actor = 'system', at = now() } = {}) {
  if (!STATUSES.includes(to)) throw new HttpError(400, `Unknown status "${to}".`);
  if (person.status === to) return person;
  const sets = ['status = ?', 'status_reason = ?', 'updated_at = ?'], args = [to, reason, at];
  if (to === 'active') { sets.push('confirmed_at = COALESCE(confirmed_at, ?)', 'subscribed_at = COALESCE(subscribed_at, ?)', 'unsubscribed_at = NULL'); args.push(at, at); }
  if (to === 'unsubscribed') { sets.push('unsubscribed_at = ?'); args.push(at); }
  await db.batch([
    stmt(db, `UPDATE people SET ${sets.join(', ')} WHERE id = ?`, ...args, person.id),
    stmt(db, 'INSERT INTO status_history (person_id, from_status, to_status, reason, actor, at) VALUES (?, ?, ?, ?, ?, ?)', person.id, person.status, to, reason, actor, at),
  ]);
  if (SUPPRESS_ON[to]) await suppress(db, person.email_norm, SUPPRESS_ON[to], actor.startsWith('webhook') ? actor : 'platform', reason);
  return { ...person, status: to, status_reason: reason };
}

/**
 * Statements that insert one person with history, attribution, tags and memberships.
 * Uses sub-selects for ids so a whole import chunk fits in a single db.batch() call
 * (D1's free plan allows only 50 queries per Worker invocation).
 */
export function personInsertStatements(db, fields, { actor = 'system', kind = 'signup', importBatchId = null } = {}) {
  const email_norm = normalizeEmail(fields.email);
  if (!validEmail(email_norm)) throw new HttpError(400, 'That email address does not look valid.');
  const at = fields.created_at || now();
  const status = fields.status || 'pending';
  const pid = '(SELECT id FROM people WHERE email_norm = ?)';
  const out = [
    stmt(db, `INSERT INTO people (email, email_norm, first_name, last_name, status, status_reason, email_verification, source,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, landing_path, signup_form, institution_id, member_loa, notes, custom, external_ids,
        token, created_at, updated_at, subscribed_at, confirmed_at, unsubscribed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      String(fields.email).trim(), email_norm, clip(fields.first_name), clip(fields.last_name), status, clip(fields.status_reason, 500),
      fields.email_verification || 'unverified', clip(fields.source),
      ...UTM.map((k) => clip(fields[k], 120)), clip(fields.referrer, 300), clip(fields.landing_path), clip(fields.signup_form, 60),
      clip(fields.institution_id, 60), fields.member_loa ? 1 : 0, clip(fields.notes, 5000),
      JSON.stringify(fields.custom || {}), JSON.stringify(fields.external_ids || {}),
      randomToken(), at, now(), fields.subscribed_at || (status === 'active' ? at : null), fields.confirmed_at || null, fields.unsubscribed_at || null),
    stmt(db, `INSERT INTO status_history (person_id, from_status, to_status, reason, actor, at) VALUES (${pid}, NULL, ?, ?, ?, ?)`, email_norm, status, fields.status_reason || kind, actor, at),
    stmt(db, `INSERT INTO attribution_events (person_id, kind, source, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, landing_path, form, import_batch_id, at)
      VALUES (${pid}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, email_norm, kind, clip(fields.source), ...UTM.map((k) => clip(fields[k], 120)), clip(fields.referrer, 300), clip(fields.landing_path), clip(fields.signup_form, 60), importBatchId, at),
    ...enrichStatements(db, email_norm, fields),
  ];
  if (SUPPRESS_ON[status]) out.push(stmt(db, 'INSERT INTO suppressions (email_norm, reason, source, detail, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email_norm) DO NOTHING',
    email_norm, fields.suppression_reason || SUPPRESS_ON[status], kind === 'migration' ? 'beehiiv-migration' : 'platform', clip(fields.status_reason, 500), now()));
  return out;
}

/** Tag and organization statements for a person addressed by email (insert-or-ignore). */
export function enrichStatements(db, email_norm, fields) {
  const pid = '(SELECT id FROM people WHERE email_norm = ?)';
  const out = [];
  for (const t of new Set((fields.tags || []).map((x) => String(x).trim()).filter(Boolean)))
    out.push(stmt(db, `INSERT INTO person_tags (person_id, tag) VALUES (${pid}, ?) ON CONFLICT DO NOTHING`, email_norm, t.slice(0, 60)));
  for (const m of fields.memberships || []) {
    const name = String(m.org || '').trim();
    if (!name) continue;
    out.push(stmt(db, 'INSERT INTO organizations (name) VALUES (?) ON CONFLICT(name) DO NOTHING', name));
    out.push(stmt(db, `INSERT INTO memberships (person_id, org_id, role) VALUES (${pid}, (SELECT id FROM organizations WHERE name = ?), ?)
      ON CONFLICT(person_id, org_id) DO UPDATE SET role = COALESCE(excluded.role, role)`, email_norm, name, clip(m.role, 80)));
  }
  return out;
}

export async function createPerson(db, fields, opts = {}) {
  await db.batch(personInsertStatements(db, fields, opts));
  return first(db, 'SELECT * FROM people WHERE email_norm = ?', normalizeEmail(fields.email));
}

/** Human-readable acquisition source from attribution fields. */
export function sourceLabel(a) {
  if (a.utm_source) return `website: ${a.utm_source} / ${a.utm_medium || '(none)'}`;
  if (a.referrer) { try { return `website: ${new URL(a.referrer).hostname} / referral`; } catch { /* fall through */ } }
  return 'website: direct / (none)';
}

/**
 * Public signup. Never reveals whether an address already exists, and never re-activates a
 * suppressed address silently: a person who unsubscribed must confirm again by email.
 * Returns { person, action } where action is one of: created, resend_confirmation, already_active, resubscribe_requested, blocked.
 */
export async function subscribe(db, input, { doubleOptIn = true } = {}) {
  const email_norm = normalizeEmail(input.email);
  if (!validEmail(email_norm)) throw new HttpError(400, 'Please enter a valid email address.');
  const attr = Object.fromEntries([...UTM, 'referrer', 'landing_path'].map((k) => [k, clip(input[k], k === 'referrer' ? 300 : 120)]));
  attr.signup_form = clip(input.form, 60);
  const existing = await first(db, 'SELECT * FROM people WHERE email_norm = ?', email_norm);
  const sup = await suppression(db, email_norm);
  if (!existing) {
    if (sup && sup.reason !== 'unsubscribed') return { person: null, action: 'blocked' }; // bounced/complained/manual: never mail
    // A suppressed (previously unsubscribed) address always needs a fresh email confirmation.
    const person = await createPerson(db, { email: input.email, ...attr, source: sourceLabel(attr), status: doubleOptIn || sup ? 'pending' : 'active' }, { actor: 'public-signup', kind: 'signup' });
    return { person, action: person.status === 'pending' ? 'created' : 'created_active' };
  }
  if (existing.status === 'active') return { person: existing, action: 'already_active' };
  if (['bounced', 'complained', 'suppressed'].includes(existing.status)) return { person: existing, action: 'blocked' };
  // prospective / pending / unsubscribed: record the new touch; confirmation email decides activation.
  await run(db, `INSERT INTO attribution_events (person_id, kind, source, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, landing_path, form, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, existing.id, existing.status === 'unsubscribed' ? 'resubscribe' : 'signup', sourceLabel(attr), ...UTM.map((k) => attr[k]), attr.referrer, attr.landing_path, attr.signup_form, now());
  if (existing.status === 'prospective') {
    const person = await setStatus(db, existing, doubleOptIn ? 'pending' : 'active', { reason: 'signed up on the website', actor: 'public-signup' });
    return { person, action: doubleOptIn ? 'created' : 'created_active' };
  }
  return { person: existing, action: existing.status === 'unsubscribed' ? 'resubscribe_requested' : 'resend_confirmation' };
}

/** Email-link confirmation. Lifts an "unsubscribed" suppression only because the owner of the inbox asked. */
export async function confirm(db, token) {
  const person = await first(db, 'SELECT * FROM people WHERE token = ?', token);
  if (!person) return null;
  if (['bounced', 'complained', 'suppressed'].includes(person.status)) return person;
  if (person.status !== 'active') {
    await run(db, "DELETE FROM suppressions WHERE email_norm = ? AND reason = 'unsubscribed'", person.email_norm);
    await run(db, "UPDATE people SET email_verification = 'verified' WHERE id = ?", person.id);
    return setStatus(db, person, 'active', { reason: 'confirmed by email link', actor: 'subscriber' });
  }
  return person;
}

export async function unsubscribe(db, token, reason = 'unsubscribe link') {
  const person = await first(db, 'SELECT * FROM people WHERE token = ?', token);
  if (!person) return null;
  if (['active', 'pending', 'prospective'].includes(person.status)) return setStatus(db, person, 'unsubscribed', { reason, actor: 'subscriber' });
  return person;
}

const EDITABLE = ['first_name', 'last_name', 'notes', 'institution_id', 'email_verification'];
export async function updatePerson(db, id, patch, actor) {
  const person = await first(db, 'SELECT * FROM people WHERE id = ?', id);
  if (!person) throw new HttpError(404, 'No such person.');
  const sets = [], args = [], changed = {};
  for (const k of EDITABLE) if (k in patch && patch[k] !== person[k]) { sets.push(`${k} = ?`); args.push(clip(patch[k], k === 'notes' ? 5000 : 200)); changed[k] = [person[k], patch[k]]; }
  if ('member_loa' in patch && !!patch.member_loa !== !!person.member_loa) { sets.push('member_loa = ?'); args.push(patch.member_loa ? 1 : 0); changed.member_loa = [person.member_loa, patch.member_loa ? 1 : 0]; }
  if ('custom' in patch) { sets.push('custom = ?'); args.push(JSON.stringify(patch.custom || {})); changed.custom = true; }
  if (patch.email && normalizeEmail(patch.email) !== person.email_norm) {
    const e = normalizeEmail(patch.email);
    if (!validEmail(e)) throw new HttpError(400, 'That email address does not look valid.');
    if (await first(db, 'SELECT id FROM people WHERE email_norm = ?', e)) throw new HttpError(409, 'Another record already uses that email address.');
    if (await suppression(db, e)) throw new HttpError(409, 'That address is on the suppression list and cannot be assigned.');
    sets.push('email = ?', 'email_norm = ?', "email_verification = 'unverified'"); args.push(String(patch.email).trim(), e); changed.email = [person.email_norm, e];
  }
  if (sets.length) {
    await run(db, `UPDATE people SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...args, now(), id);
    await audit(db, actor, 'person.update', 'person', id, changed);
  }
  if (Array.isArray(patch.tags)) {
    await run(db, 'DELETE FROM person_tags WHERE person_id = ?', id);
    for (const t of new Set(patch.tags.map((x) => String(x).trim()).filter(Boolean))) await run(db, 'INSERT INTO person_tags (person_id, tag) VALUES (?, ?)', id, t.slice(0, 60));
  }
  if (Array.isArray(patch.memberships)) {
    await run(db, 'DELETE FROM memberships WHERE person_id = ?', id);
    for (const m of patch.memberships) await addMembership(db, id, m.org, m.role);
  }
  return getPerson(db, id);
}

export async function addMembership(db, personId, orgName, role = null) {
  const name = String(orgName || '').trim();
  if (!name) return;
  await run(db, 'INSERT INTO organizations (name) VALUES (?) ON CONFLICT(name) DO NOTHING', name);
  const org = await first(db, 'SELECT id FROM organizations WHERE name = ?', name);
  await run(db, 'INSERT INTO memberships (person_id, org_id, role) VALUES (?, ?, ?) ON CONFLICT(person_id, org_id) DO UPDATE SET role = COALESCE(excluded.role, role)', personId, org.id, clip(role, 80));
}

export async function getPerson(db, id) {
  const person = await first(db, 'SELECT * FROM people WHERE id = ?', id);
  if (!person) throw new HttpError(404, 'No such person.');
  const [tags, memberships, history, interactions, attribution, deliveries] = await Promise.all([
    all(db, 'SELECT tag FROM person_tags WHERE person_id = ? ORDER BY tag', id),
    all(db, 'SELECT o.name AS org, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.person_id = ? ORDER BY o.name', id),
    all(db, 'SELECT from_status, to_status, reason, actor, at FROM status_history WHERE person_id = ? ORDER BY id', id),
    all(db, 'SELECT id, kind, body, actor, at FROM interactions WHERE person_id = ? ORDER BY at DESC', id),
    all(db, 'SELECT * FROM attribution_events WHERE person_id = ? ORDER BY id', id),
    all(db, 'SELECT r.send_id, s.issue_slug, r.status, r.sent_at, r.opens, r.clicks FROM send_recipients r JOIN sends s ON s.id = r.send_id WHERE r.person_id = ? ORDER BY r.send_id DESC LIMIT 60', id),
  ]);
  const { token, ...safe } = person;
  return { ...safe, custom: JSON.parse(person.custom), external_ids: JSON.parse(person.external_ids), tags: tags.map((t) => t.tag), memberships, history, interactions, attribution, deliveries };
}

/** Filtered list for the admin UI and exports. */
export function peopleQuery(f = {}) {
  const where = [], args = [];
  if (f.status) { where.push('p.status = ?'); args.push(f.status); }
  if (f.q) { where.push('(p.email_norm LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ? OR p.institution_id LIKE ? OR p.notes LIKE ?)'); const q = `%${String(f.q).toLowerCase().replace(/[%_]/g, '')}%`; args.push(q, q, q, q, q); }
  if (f.org) { where.push('EXISTS (SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.person_id = p.id AND o.name = ?)'); args.push(f.org); }
  if (f.tag) { where.push('EXISTS (SELECT 1 FROM person_tags t WHERE t.person_id = p.id AND t.tag = ?)'); args.push(f.tag); }
  if (f.source) { where.push('p.source = ?'); args.push(f.source); }
  if (f.campaign) { where.push('p.utm_campaign = ?'); args.push(f.campaign); }
  if (f.loa === '1') where.push('p.member_loa = 1');
  if (f.verification) { where.push('p.email_verification = ?'); args.push(f.verification); }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

export const PEOPLE_COLUMNS = ['id', 'email', 'first_name', 'last_name', 'status', 'status_reason', 'email_verification', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'referrer', 'landing_path', 'signup_form', 'institution_id', 'member_loa', 'organizations', 'tags', 'notes', 'created_at', 'subscribed_at', 'confirmed_at', 'unsubscribed_at', 'updated_at'];

export async function listPeople(db, f = {}, { limit = 50, offset = 0 } = {}) {
  const { where, args } = peopleQuery(f);
  const total = (await first(db, `SELECT COUNT(*) AS n FROM people p ${where}`, ...args)).n;
  const rows = await all(db, `SELECT p.*,
      (SELECT GROUP_CONCAT(o.name || CASE WHEN m.role IS NULL THEN '' ELSE ' (' || m.role || ')' END, '; ') FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.person_id = p.id) AS organizations,
      (SELECT GROUP_CONCAT(tag, '; ') FROM person_tags t WHERE t.person_id = p.id) AS tags
    FROM people p ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
  return { total, rows: rows.map(({ token, custom, external_ids, ...r }) => r) };
}
