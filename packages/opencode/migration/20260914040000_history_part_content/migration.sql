-- Add previously omitted part content once, including databases that completed v3.
INSERT INTO history_index_migration
SELECT 4, CASE WHEN NOT EXISTS (SELECT 1 FROM history_fts LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM part LIMIT 1) THEN 'done' ELSE 'clean' END, 0,
  COALESCE((SELECT MAX(rowid) FROM history_fts), 0),
  COALESCE((SELECT MAX(rowid) FROM part), 0);
