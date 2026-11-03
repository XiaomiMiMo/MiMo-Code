-- Cloud session sharing was removed: clear local share records and links.
-- The table and column stay because older clients sharing this database still read them.
-- Keep this directory name: drizzle tracks applied migrations by name, and databases that ran an
-- earlier draft (which dropped both) must skip this one rather than update a missing column.
UPDATE `session` SET `share_url` = NULL;--> statement-breakpoint
DELETE FROM `session_share`;
