-- Staged rollouts: an optional audience filter per send (for example {"tag":"pilot"}).
ALTER TABLE sends ADD COLUMN audience TEXT NOT NULL DEFAULT '{}';
