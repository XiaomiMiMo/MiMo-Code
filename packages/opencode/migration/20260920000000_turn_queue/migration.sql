CREATE TABLE `turn_session_epoch` (
  `session_id` text PRIMARY KEY NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `epoch` integer NOT NULL DEFAULT 0,
  `time_updated` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `turn_lane_state` (
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `agent_id` text NOT NULL DEFAULT 'main',
  `consumed_frontier` text,
  `input_revision` integer NOT NULL DEFAULT 0,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`session_id`, `agent_id`)
);--> statement-breakpoint
CREATE TABLE `turn_receipt` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `agent_id` text NOT NULL DEFAULT 'main',
  `state` text NOT NULL,
  `intent` text NOT NULL,
  `epoch` integer NOT NULL,
  `run_id` integer,
  `claim_frontier` text,
  `consumed` integer NOT NULL DEFAULT false,
  `suspended` integer NOT NULL DEFAULT false,
  `outcome` text,
  `message_id` text,
  `error` text,
  `idempotency_key` text NOT NULL DEFAULT '',
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `turn_receipt_lane_state_idx` ON `turn_receipt` (`session_id`,`agent_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `turn_receipt_idem_idx` ON `turn_receipt` (`session_id`,`idempotency_key`) WHERE `idempotency_key` != '';--> statement-breakpoint
CREATE TABLE `turn_legacy_bootstrap` (
  `session_id` text PRIMARY KEY NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `message_ids` text NOT NULL DEFAULT '[]',
  `completed` integer NOT NULL DEFAULT true,
  `time_updated` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `turn_legacy_bootstrap` (`session_id`, `message_ids`, `completed`, `time_updated`)
SELECT `session`.`id`,
  (SELECT json_group_array(`message`.`id`) FROM `message`
    WHERE `message`.`session_id` = `session`.`id` AND `message`.`agent_id` = 'main'),
  false, CAST(strftime('%s', 'now') AS integer) * 1000
FROM `session`;
