CREATE TABLE `history_fts` (
  `part_id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `message_id` text NOT NULL,
  `project_id` text NOT NULL,
  `kind` text NOT NULL,
  `tool_name` text,
  `body` text NOT NULL,
  `time_created` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `history_fts_session_idx` ON `history_fts` (`session_id`, `time_created`);--> statement-breakpoint
CREATE INDEX `history_fts_project_idx` ON `history_fts` (`project_id`, `time_created`);--> statement-breakpoint
CREATE INDEX `history_fts_message_idx` ON `history_fts` (`message_id`);--> statement-breakpoint
CREATE VIRTUAL TABLE `history_fts_idx` USING fts5(
  body,
  content='history_fts',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);--> statement-breakpoint
CREATE TRIGGER `history_fts_ai` AFTER INSERT ON `history_fts` BEGIN
  INSERT INTO `history_fts_idx`(rowid, body) VALUES (NEW.rowid, NEW.body);
END;--> statement-breakpoint
CREATE TRIGGER `history_fts_ad` AFTER DELETE ON `history_fts` BEGIN
  INSERT INTO `history_fts_idx`(`history_fts_idx`, rowid, body) VALUES('delete', OLD.rowid, OLD.body);
END;--> statement-breakpoint
CREATE TRIGGER `history_fts_au` AFTER UPDATE ON `history_fts` BEGIN
  INSERT INTO `history_fts_idx`(`history_fts_idx`, rowid, body) VALUES('delete', OLD.rowid, OLD.body);
  INSERT INTO `history_fts_idx`(rowid, body) VALUES (NEW.rowid, NEW.body);
END;
