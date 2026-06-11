UPDATE `message` SET `agent_id` = 'main' WHERE `agent_id` IS NULL;--> statement-breakpoint
CREATE TABLE `message_new` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `agent_id` text NOT NULL DEFAULT 'main',
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);--> statement-breakpoint
INSERT INTO `message_new` SELECT `id`, `session_id`, COALESCE(`agent_id`, 'main'), `time_created`, `time_updated`, `data` FROM `message`;--> statement-breakpoint
DROP TABLE `message`;--> statement-breakpoint
ALTER TABLE `message_new` RENAME TO `message`;--> statement-breakpoint
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);--> statement-breakpoint
CREATE INDEX `message_session_agent_idx` ON `message` (`session_id`,`agent_id`,`id`);
