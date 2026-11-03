-- Cloud session sharing was removed: drop its share records and the session link column.
DROP TABLE IF EXISTS `session_share`;--> statement-breakpoint
ALTER TABLE `session` DROP COLUMN `share_url`;
