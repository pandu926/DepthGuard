-- Continue descending signature scans across restarts without skipping the previous high-water mark.
ALTER TABLE indexer_cursors ADD COLUMN before_signature text;
ALTER TABLE indexer_cursors ADD COLUMN pending_tip text;
ALTER TABLE indexer_cursors ADD COLUMN pending_tip_slot bigint;
