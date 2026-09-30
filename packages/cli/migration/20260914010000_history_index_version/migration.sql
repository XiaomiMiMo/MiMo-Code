-- Repair both deleted and partially restored indexes. A nonempty index is not
-- evidence that the previously shipped rebuild finished.
CREATE TABLE history_index_migration (
  version integer PRIMARY KEY NOT NULL,
  phase text NOT NULL,
  cursor integer NOT NULL,
  fts_end integer NOT NULL,
  part_end integer NOT NULL
);--> statement-breakpoint
INSERT INTO history_index_migration
SELECT 2, CASE WHEN NOT EXISTS (SELECT 1 FROM history_fts LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM part LIMIT 1) THEN 'done' ELSE 'clean' END, 0,
  COALESCE((SELECT MAX(rowid) FROM history_fts), 0),
  COALESCE((SELECT MAX(rowid) FROM part), 0);--> statement-breakpoint

-- Imports replace messages without publishing Bus events. Cascaded part removal
-- must remove the corresponding derived text within the same transaction.
CREATE TRIGGER history_part_ad AFTER DELETE ON part BEGIN
  DELETE FROM history_fts WHERE part_id = OLD.id;
END;
