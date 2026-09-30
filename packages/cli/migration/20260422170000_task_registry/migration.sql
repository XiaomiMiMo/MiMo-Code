CREATE TABLE `task_registry` (
  `id` text PRIMARY KEY,
  `parent_session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `status` text NOT NULL,
  `agent` text NOT NULL,
  `description` text NOT NULL,
  `context_mode` text NOT NULL,
  `background` integer NOT NULL,
  `last_turn_time` integer NOT NULL,
  `turn_count` integer NOT NULL DEFAULT 0,
  `error` text,
  `time_completed` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `task_registry_parent_idx` ON `task_registry` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `task_registry_status_idx` ON `task_registry` (`status`);--> statement-breakpoint
CREATE INDEX `task_registry_status_last_turn_idx` ON `task_registry` (`status`, `last_turn_time`);
