-- Expand existing indexes to include reasoning, tool results and file metadata.
-- Preserve searchable rows while the bounded, resumable upgrade replaces them.
INSERT INTO history_index_migration
SELECT 3, CASE WHEN NOT EXISTS (SELECT 1 FROM history_fts LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM part LIMIT 1) THEN 'done' ELSE 'clean' END, 0,
  COALESCE((SELECT MAX(rowid) FROM history_fts), 0),
  COALESCE((SELECT MAX(rowid) FROM part), 0);
