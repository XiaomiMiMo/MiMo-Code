-- Re-chunk oversized history FTS bodies and cover chunk part_ids in the delete trigger.
-- Always start clean→repair so partially indexed DBs are repaired even without oversized rows.
INSERT INTO history_index_migration
SELECT 5, 'clean', 0,
  COALESCE((SELECT MAX(rowid) FROM history_fts), 0),
  COALESCE((SELECT MAX(rowid) FROM part), 0);

DROP TRIGGER IF EXISTS `history_part_ad`;
CREATE TRIGGER `history_part_ad` AFTER DELETE ON part BEGIN
  DELETE FROM history_fts
  WHERE part_id = OLD.id
     OR substr(part_id, 1, length(OLD.id) + 1) = OLD.id || '#';
END;
