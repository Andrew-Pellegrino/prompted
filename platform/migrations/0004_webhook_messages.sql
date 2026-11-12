-- Every provider report we accept is remembered by its message id, so a report that is delivered twice
-- (SNS retries, a captured message replayed) is processed only once.
CREATE TABLE webhook_messages (
  provider TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT,                       -- Notification, SubscriptionConfirmation, or the SES event type inside
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, message_id)
);
CREATE INDEX webhook_messages_received ON webhook_messages(received_at);
