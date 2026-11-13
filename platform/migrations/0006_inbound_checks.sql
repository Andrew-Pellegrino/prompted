-- Header checks of our own test emails, received back through Cloudflare Email Routing at one address on
-- our own domain. Only headers that describe delivery and authentication are kept; never a message body.
CREATE TABLE inbound_checks (
  id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,
  mail_from TEXT, rcpt_to TEXT, subject TEXT,
  headers TEXT NOT NULL      -- JSON: selected header name -> value
);
