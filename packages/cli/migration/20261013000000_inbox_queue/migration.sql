CREATE TABLE `inbox_new` (
  `id` text PRIMARY KEY NOT NULL,
  `receiver_session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `receiver_actor_id` text NOT NULL DEFAULT 'main',
  `sender_session_id` text,
  `sender_actor_id` text,
  `type` text NOT NULL DEFAULT 'text',
  `content` text,
  `input_message_id` text,
  `state` text NOT NULL DEFAULT 'accepted',
  `epoch` integer NOT NULL DEFAULT 0,
  `run_id` integer,
  `claim_frontier` text,
  `consumed` integer NOT NULL DEFAULT 0,
  `outcome` text,
  `delivery_message_id` text,
  `error` text,
  `idempotency_key` text NOT NULL DEFAULT '',
  `created_at` integer NOT NULL,
  `time_updated` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `inbox_new` (`id`, `receiver_session_id`, `receiver_actor_id`, `sender_session_id`, `sender_actor_id`, `type`, `content`, `input_message_id`, `state`, `epoch`, `run_id`, `claim_frontier`, `consumed`, `outcome`, `delivery_message_id`, `error`, `idempotency_key`, `created_at`, `time_updated`)
SELECT `id`, `receiver_session_id`, `receiver_actor_id`, `sender_session_id`, `sender_actor_id`, `type`, `content`, NULL, 'accepted', 0, NULL, NULL, 0, NULL, NULL, NULL, '', `created_at`, `created_at` FROM `inbox`;--> statement-breakpoint
DROP TABLE `inbox`;--> statement-breakpoint
ALTER TABLE `inbox_new` RENAME TO `inbox`;--> statement-breakpoint
CREATE INDEX `inbox_receiver_idx` ON `inbox` (`receiver_session_id`,`receiver_actor_id`,`id`);--> statement-breakpoint
CREATE INDEX `inbox_state_idx` ON `inbox` (`receiver_session_id`,`receiver_actor_id`,`state`);--> statement-breakpoint
CREATE INDEX `inbox_created_idx` ON `inbox` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_idem_idx` ON `inbox` (`receiver_session_id`,`idempotency_key`) WHERE `idempotency_key` != '';--> statement-breakpoint
CREATE TABLE `inbox_lane_state` (
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `agent_id` text NOT NULL DEFAULT 'main',
  `consumed_frontier` text,
  `input_revision` integer NOT NULL DEFAULT 0,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`session_id`, `agent_id`)
);--> statement-breakpoint
CREATE TABLE `inbox_session_epoch` (
  `session_id` text PRIMARY KEY NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `epoch` integer NOT NULL DEFAULT 0,
  `time_updated` integer NOT NULL
);
