DROP TABLE `actor_registry`;--> statement-breakpoint
CREATE TABLE `actor_registry` (
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `actor_id` text NOT NULL,
  `mode` text NOT NULL,
  `parent_actor_id` text,
  `status` text NOT NULL,
  `agent` text NOT NULL,
  `description` text NOT NULL,
  `context_mode` text NOT NULL,
  `context_watermark` text,
  `background` integer NOT NULL,
  `tools` text,
  `last_turn_time` integer NOT NULL,
  `turn_count` integer NOT NULL DEFAULT 0,
  `error` text,
  `time_completed` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`session_id`, `actor_id`)
);--> statement-breakpoint
CREATE INDEX `actor_registry_session_agent_idx` ON `actor_registry` (`session_id`, `agent`);--> statement-breakpoint
CREATE INDEX `actor_registry_session_parent_idx` ON `actor_registry` (`session_id`, `parent_actor_id`);--> statement-breakpoint
CREATE INDEX `actor_registry_status_idx` ON `actor_registry` (`status`);--> statement-breakpoint
CREATE INDEX `actor_registry_status_last_turn_idx` ON `actor_registry` (`status`, `last_turn_time`);
