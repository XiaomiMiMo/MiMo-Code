CREATE TABLE `memory_fts` (
  `path` text PRIMARY KEY NOT NULL,
  `scope` text NOT NULL,
  `scope_id` text DEFAULT '' NOT NULL,
  `type` text NOT NULL,
  `body` text NOT NULL,
  `fingerprint` text NOT NULL,
  `last_indexed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memory_fts_scope_idx` ON `memory_fts` (`scope`, `scope_id`);
--> statement-breakpoint
CREATE INDEX `memory_fts_type_idx` ON `memory_fts` (`type`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `memory_fts_idx` USING fts5(
  body,
  content='memory_fts',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);
--> statement-breakpoint
CREATE TRIGGER `memory_fts_ai` AFTER INSERT ON `memory_fts` BEGIN
  INSERT INTO `memory_fts_idx`(rowid, body) VALUES (NEW.rowid, NEW.body);
END;
--> statement-breakpoint
CREATE TRIGGER `memory_fts_ad` AFTER DELETE ON `memory_fts` BEGIN
  DELETE FROM `memory_fts_idx` WHERE rowid = OLD.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_fts_au` AFTER UPDATE ON `memory_fts` BEGIN
  DELETE FROM `memory_fts_idx` WHERE rowid = OLD.rowid;
  INSERT INTO `memory_fts_idx`(rowid, body) VALUES (NEW.rowid, NEW.body);
END;
