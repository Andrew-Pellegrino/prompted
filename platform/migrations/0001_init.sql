-- Prompted platform schema (Cloudflare D1 / SQLite).
-- The database is the single source of truth for the audience. It is private: reachable only
-- through the Worker's authenticated admin API. Nothing here is ever written to the static site.

CREATE TABLE people (
  id                 INTEGER PRIMARY KEY,
  email              TEXT NOT NULL,                 -- as supplied (display form)
  email_norm         TEXT NOT NULL UNIQUE,          -- trimmed + lower-cased; the identity key
  first_name         TEXT,
  last_name          TEXT,
  status             TEXT NOT NULL CHECK (status IN ('prospective','pending','active','unsubscribed','bounced','complained','suppressed')),
  status_reason      TEXT,
  email_verification TEXT NOT NULL DEFAULT 'unverified' CHECK (email_verification IN ('verified','inferred','unverified')),
  source             TEXT,                          -- original acquisition source, never overwritten
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  referrer           TEXT,
  landing_path       TEXT,
  signup_form        TEXT,
  institution_id     TEXT,                          -- e.g. a roster "Unique ID"; data only, not an account dependency
  member_loa         INTEGER NOT NULL DEFAULT 0,    -- roster "Member LOA" flag; a source status, not an email-validity verdict
  notes              TEXT,
  custom             TEXT NOT NULL DEFAULT '{}',    -- JSON: custom fields
  external_ids       TEXT NOT NULL DEFAULT '{}',    -- JSON: ids in other systems (e.g. beehiiv subscription id)
  token              TEXT NOT NULL UNIQUE,          -- per-person secret for confirm/unsubscribe/tracking links
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  subscribed_at      TEXT,                          -- original subscribe time (preserved across migration)
  confirmed_at       TEXT,
  unsubscribed_at    TEXT
);
CREATE INDEX people_status ON people(status);
CREATE INDEX people_institution ON people(institution_id);

CREATE TABLE status_history (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT NOT NULL, reason TEXT, actor TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX status_history_person ON status_history(person_id);

-- Addresses that must never be mailed or re-activated by an import or a signup sync.
-- Keyed by address (not person) so it survives record deletion and provider changes.
CREATE TABLE suppressions (
  email_norm TEXT PRIMARY KEY,
  reason     TEXT NOT NULL CHECK (reason IN ('unsubscribed','bounced','complained','manual','invalid')),
  source     TEXT NOT NULL,                         -- 'beehiiv-migration', 'platform', 'webhook:brevo', ...
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE memberships (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  org_id    INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role      TEXT,
  PRIMARY KEY (person_id, org_id)
);
CREATE TABLE person_tags (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (person_id, tag)
);
CREATE TABLE interactions (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, body TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX interactions_person ON interactions(person_id);

-- Every acquisition touch (first signup, re-subscribe, import), newest last.
CREATE TABLE attribution_events (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('signup','resubscribe','import','migration')),
  source TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  referrer TEXT, landing_path TEXT, form TEXT, import_batch_id INTEGER, at TEXT NOT NULL
);
CREATE INDEX attribution_person ON attribution_events(person_id);

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  filename TEXT, sha256 TEXT NOT NULL, source_label TEXT NOT NULL,
  target_status TEXT NOT NULL, era TEXT NOT NULL DEFAULT 'platform',
  totals TEXT NOT NULL DEFAULT '{}', actor TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX import_batches_sha ON import_batches(sha256, source_label, target_status);
CREATE TABLE import_rows (
  batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL, email_norm TEXT, outcome TEXT NOT NULL, detail TEXT,
  PRIMARY KEY (batch_id, row_no)
);

-- One row per issue send (or test send).
CREATE TABLE sends (
  id INTEGER PRIMARY KEY,
  issue_slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue','test')),
  subject TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','approved','scheduled','sending','sent','failed','cancelled')),
  content_sha256 TEXT NOT NULL,                     -- approved content hash; a changed issue needs re-approval
  qa TEXT NOT NULL DEFAULT '{}',
  scheduled_at TEXT, approved_at TEXT, approved_by TEXT,
  started_at TEXT, finished_at TEXT,
  totals TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
-- Only one live (non-test, non-cancelled, non-failed) send per issue: no accidental duplicate sends.
CREATE UNIQUE INDEX sends_one_live_per_issue ON sends(issue_slug) WHERE kind = 'issue' AND status NOT IN ('cancelled','failed');

CREATE TABLE send_recipients (
  send_id INTEGER NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
  person_id INTEGER,                                -- NULL for ad-hoc test addresses
  email_norm TEXT NOT NULL,
  token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','sending','sent','delivered','bounced','complained','failed','skipped')),
  claimed_at TEXT,                                  -- set when handed to a provider; a stale claim is never auto-resent
  provider TEXT, provider_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  sent_at TEXT, delivered_at TEXT, first_opened_at TEXT, first_clicked_at TEXT,
  opens INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (send_id, email_norm)                 -- a person can never be queued twice for one send
);
CREATE INDEX send_recipients_status ON send_recipients(send_id, status);
CREATE INDEX send_recipients_msg ON send_recipients(provider_message_id);

CREATE TABLE send_links (
  send_id INTEGER NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, url TEXT NOT NULL, clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (send_id, idx)
);

CREATE TABLE delivery_events (
  id INTEGER PRIMARY KEY, send_id INTEGER, email_norm TEXT NOT NULL,
  type TEXT NOT NULL,                               -- sent, delivered, bounce_hard, bounce_soft, complaint, unsubscribe, open, click, failed
  provider TEXT, detail TEXT, at TEXT NOT NULL
);
CREATE INDEX delivery_events_send ON delivery_events(send_id, type);
CREATE INDEX delivery_events_email ON delivery_events(email_norm);

-- Daily usage per provider, for free-tier quota enforcement.
CREATE TABLE provider_usage (
  provider TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day)
);

-- Per-issue metrics. era = 'beehiiv' rows are imported history and are never recomputed;
-- era = 'platform' rows are computed from send_recipients. Definitions differ and are shown separately.
CREATE TABLE issue_metrics (
  issue_slug TEXT NOT NULL, era TEXT NOT NULL CHECK (era IN ('beehiiv','platform')),
  recipients INTEGER, delivered INTEGER, opens INTEGER, unique_opens INTEGER,
  clicks INTEGER, unique_clicks INTEGER, verified_clicks INTEGER, unique_verified_clicks INTEGER,
  unsubscribes INTEGER, spam_reports INTEGER, bounces INTEGER, web_views INTEGER, web_clicks INTEGER,
  captured_at TEXT NOT NULL, note TEXT,
  PRIMARY KEY (issue_slug, era)
);
CREATE TABLE growth_series (
  day TEXT NOT NULL, era TEXT NOT NULL CHECK (era IN ('beehiiv','platform')),
  active INTEGER, new_subscribers INTEGER, unsubscribes INTEGER, note TEXT,
  PRIMARY KEY (day, era)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT
);
CREATE INDEX audit_at ON audit_log(at);

CREATE TABLE rate_limits (
  key TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
