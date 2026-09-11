-- Derived index only. Existing delete triggers clear FTS; startup backfill is
-- resumable via NOT EXISTS. Original parts and sessions remain untouched.
DELETE FROM history_fts;
