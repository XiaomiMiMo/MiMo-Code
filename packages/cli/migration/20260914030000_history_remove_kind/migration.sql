-- Remove the unused classification without deleting index text or changing rowids.
ALTER TABLE history_fts DROP COLUMN kind;
