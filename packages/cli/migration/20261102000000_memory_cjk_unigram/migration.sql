ALTER TABLE memory_fts ADD COLUMN body_idx text NOT NULL DEFAULT '';--> statement-breakpoint
DROP TRIGGER IF EXISTS memory_fts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS memory_fts_ad;--> statement-breakpoint
DROP TRIGGER IF EXISTS memory_fts_au;--> statement-breakpoint
DROP TABLE IF EXISTS memory_fts_idx;--> statement-breakpoint
CREATE VIRTUAL TABLE memory_fts_idx USING fts5(
  body_idx, content='memory_fts', content_rowid='id',
  tokenize='unicode61 remove_diacritics 1'
);--> statement-breakpoint
-- Align the empty search column before UPDATE triggers can delete its tokens.
INSERT INTO memory_fts_idx(memory_fts_idx) VALUES('rebuild');--> statement-breakpoint
CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_fts BEGIN
  INSERT INTO memory_fts_idx(rowid, body_idx) VALUES(NEW.id, NEW.body_idx);
END;--> statement-breakpoint
CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory_fts BEGIN
  INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body_idx) VALUES('delete', OLD.id, OLD.body_idx);
END;--> statement-breakpoint
CREATE TRIGGER memory_fts_au AFTER UPDATE ON memory_fts BEGIN
  INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body_idx) VALUES('delete', OLD.id, OLD.body_idx);
  INSERT INTO memory_fts_idx(rowid, body_idx) VALUES(NEW.id, NEW.body_idx);
END;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS memory_index_migration(version integer PRIMARY KEY NOT NULL, cursor integer NOT NULL DEFAULT 0);--> statement-breakpoint
-- Fresh installs have nothing to backfill and must not start a background job.
INSERT OR IGNORE INTO memory_index_migration(version) SELECT 1 WHERE EXISTS (SELECT 1 FROM memory_fts);
