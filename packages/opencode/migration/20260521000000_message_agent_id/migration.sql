ALTER TABLE `message` ADD `agent_id` text;--> statement-breakpoint
CREATE INDEX `message_session_agent_idx` ON `message` (`session_id`,`agent_id`,`id`);
