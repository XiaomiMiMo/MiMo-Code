CREATE TABLE IF NOT EXISTS `turn_legacy_bootstrap` (
  `session_id` text PRIMARY KEY NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `message_ids` text NOT NULL DEFAULT '[]',
  `completed` integer NOT NULL DEFAULT true,
  `time_updated` integer NOT NULL
);--> statement-breakpoint
INSERT OR IGNORE INTO `turn_legacy_bootstrap` (`session_id`, `message_ids`, `completed`, `time_updated`)
SELECT `id`, '[]', true, CAST(strftime('%s', 'now') AS integer) * 1000 FROM `session`;--> statement-breakpoint
ALTER TABLE `turn_receipt` ADD COLUMN `delivery_message_id` text;
