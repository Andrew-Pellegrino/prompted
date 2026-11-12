-- First-party engagement analytics.
-- A random tracking id per recipient per send replaces the subscriber token in tracking URLs, so a
-- tracking link reveals nothing about the reader, cannot unsubscribe anyone, and cannot be linked across sends.
ALTER TABLE send_recipients ADD COLUMN track_id TEXT;
UPDATE send_recipients SET track_id = lower(hex(randomblob(12))) WHERE track_id IS NULL;
CREATE UNIQUE INDEX send_recipients_track ON send_recipients(track_id);

-- What each tracked link is, for reports: body link text, a template link, or an Index term.
ALTER TABLE send_links ADD COLUMN label TEXT;
ALTER TABLE send_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'body';   -- body | template | index_term

-- One row per open or click. No IP address and no raw user agent are stored: only a coarse class.
CREATE TABLE engagement_events (
  id INTEGER PRIMARY KEY,
  send_id INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('open','click')),
  link_idx INTEGER,
  at TEXT NOT NULL,
  agent TEXT NOT NULL      -- browser | gmail_proxy | apple_privacy | microsoft_network | scanner | head
);
CREATE INDEX engagement_events_send ON engagement_events(send_id, kind);
CREATE INDEX engagement_events_track ON engagement_events(track_id, kind, at);
CREATE INDEX engagement_events_at ON engagement_events(at);

-- Report for a send, saved before its events are deleted under the retention rule.
CREATE TABLE engagement_summaries (
  send_id INTEGER PRIMARY KEY,
  computed_at TEXT NOT NULL,
  data TEXT NOT NULL
);
