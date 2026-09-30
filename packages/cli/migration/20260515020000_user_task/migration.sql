CREATE TABLE `task` (
  `id` text NOT NULL,
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `parent_task_id` text,
  `kind` text NOT NULL DEFAULT 'user',
  `status` text NOT NULL,
  `focus` integer NOT NULL DEFAULT 0,
  `summary` text NOT NULL,
  `created_at` integer NOT NULL,
  `last_event_at` integer NOT NULL,
  `ended_at` integer,
  `cleanup_after` integer,
  PRIMARY KEY (`session_id`, `id`)
);--> statement-breakpoint
CREATE INDEX `task_session_idx` ON `task` (`session_id`);--> statement-breakpoint
CREATE INDEX `task_parent_idx` ON `task` (`session_id`, `parent_task_id`);--> statement-breakpoint
CREATE INDEX `task_status_idx` ON `task` (`status`);--> statement-breakpoint
CREATE INDEX `task_kind_idx` ON `task` (`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_focus_per_session_idx` ON `task` (`session_id`) WHERE focus = 1;--> statement-breakpoint
CREATE TABLE `task_event` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `task_id` text NOT NULL,
  `at` integer NOT NULL,
  `kind` text NOT NULL,
  `summary` text,
  FOREIGN KEY (`session_id`, `task_id`) REFERENCES `task`(`session_id`, `id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX `task_event_task_idx` ON `task_event` (`session_id`, `task_id`, `at`);
