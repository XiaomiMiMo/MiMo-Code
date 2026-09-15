-- Existing v5 installs also need to remove chunks already written by that version.
INSERT INTO history_index_migration
SELECT 6, 'clean', 0,
  COALESCE((SELECT MAX(rowid) FROM history_fts), 0),
  COALESCE((SELECT MAX(rowid) FROM part), 0);--> statement-breakpoint

-- Close superseded migration state so prior versions do not linger as 'clean'.
UPDATE history_index_migration SET phase='done' WHERE version < 6;--> statement-breakpoint

DROP TRIGGER IF EXISTS `history_part_ad`;--> statement-breakpoint
CREATE TRIGGER `history_part_ad` AFTER DELETE ON part BEGIN
  DELETE FROM history_fts
  WHERE part_id = OLD.id
     OR (part_id >= OLD.id || '#' AND part_id < OLD.id || '$');
END;
