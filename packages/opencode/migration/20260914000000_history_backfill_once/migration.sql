-- Existing indexes are authoritative; do not sweep them for missing parts.
-- A database cleared by the media migration needs one background rebuild.
CREATE TABLE `history_backfill` (
  `id` integer PRIMARY KEY NOT NULL,
  `completed` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `history_backfill` (`id`, `completed`)
SELECT 1, CASE
  WHEN EXISTS (SELECT 1 FROM history_fts LIMIT 1) THEN 1
  WHEN NOT EXISTS (SELECT 1 FROM part LIMIT 1) THEN 1
  ELSE 0
END;
