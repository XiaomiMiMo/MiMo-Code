-- Fix v6.1 trigger pattern: external content FTS5 vtab requires the 'delete'
-- magic command to remove OLD body's tokens, NOT a plain DELETE FROM the vtab.
-- The previous DELETE FROM pattern was contentless-mode syntax misapplied to
-- external-content mode, leaving stale tokens accumulating until vtab corrupts.
DROP TRIGGER IF EXISTS `memory_fts_ai`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `memory_fts_ad`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `memory_fts_au`;--> statement-breakpoint
CREATE TRIGGER `memory_fts_ai` AFTER INSERT ON `memory_fts` BEGIN
  INSERT INTO `memory_fts_idx`(rowid, body) VALUES (NEW.id, NEW.body);
END;--> statement-breakpoint
CREATE TRIGGER `memory_fts_ad` AFTER DELETE ON `memory_fts` BEGIN
  INSERT INTO `memory_fts_idx`(`memory_fts_idx`, rowid, body) VALUES('delete', OLD.id, OLD.body);
END;--> statement-breakpoint
CREATE TRIGGER `memory_fts_au` AFTER UPDATE ON `memory_fts` BEGIN
  INSERT INTO `memory_fts_idx`(`memory_fts_idx`, rowid, body) VALUES('delete', OLD.id, OLD.body);
  INSERT INTO `memory_fts_idx`(rowid, body) VALUES (NEW.id, NEW.body);
END;
