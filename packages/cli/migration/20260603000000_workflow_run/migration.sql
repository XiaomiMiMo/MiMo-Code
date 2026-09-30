CREATE TABLE `workflow_run` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `status` text NOT NULL,
  `running` integer NOT NULL DEFAULT 0,
  `succeeded` integer NOT NULL DEFAULT 0,
  `failed` integer NOT NULL DEFAULT 0,
  `current_phase` text,
  `parent_actor_id` text,
  `args` text,
  `error` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `workflow_run_session_idx` ON `workflow_run` (`session_id`);--> statement-breakpoint
CREATE INDEX `workflow_run_status_idx` ON `workflow_run` (`status`);
