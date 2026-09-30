CREATE TABLE `inbox` (
  `id` text PRIMARY KEY NOT NULL,
  `receiver_session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `receiver_actor_id` text NOT NULL,
  `sender_session_id` text,
  `sender_actor_id` text,
  `type` text NOT NULL DEFAULT 'text',
  `content` text NOT NULL,
  `created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `inbox_receiver_idx` ON `inbox` (`receiver_session_id`,`receiver_actor_id`,`id`);--> statement-breakpoint
CREATE INDEX `inbox_created_idx` ON `inbox` (`created_at`);
