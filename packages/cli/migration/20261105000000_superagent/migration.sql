CREATE TABLE `superagent_ticket` (`id` text PRIMARY KEY, `directory` text NOT NULL, `phase` text NOT NULL, `data` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `superagent_ticket_scope_idx` ON `superagent_ticket` (`directory`, `phase`);
--> statement-breakpoint
CREATE TABLE `superagent_input` (`id` text PRIMARY KEY, `directory` text NOT NULL, `ticket_id` text REFERENCES `superagent_ticket` (`id`), `channel` text NOT NULL, `event_id` text NOT NULL, `thread_id` text NOT NULL, `source` text NOT NULL, `text` text NOT NULL, `kind` text NOT NULL, `fingerprint` text NOT NULL, `time_created` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `superagent_input_dedup_idx` ON `superagent_input` (`directory`, `channel`, `event_id`);
--> statement-breakpoint
CREATE INDEX `superagent_input_thread_idx` ON `superagent_input` (`directory`, `channel`, `thread_id`);
--> statement-breakpoint
CREATE TABLE `superagent_run` (`id` text PRIMARY KEY, `ticket_id` text NOT NULL REFERENCES `superagent_ticket` (`id`), `state` text NOT NULL, `data` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `superagent_run_ticket_idx` ON `superagent_run` (`ticket_id`);
--> statement-breakpoint
CREATE TABLE `superagent_action` (`id` text PRIMARY KEY, `key` text NOT NULL UNIQUE, `directory` text NOT NULL, `ticket_id` text REFERENCES `superagent_ticket` (`id`), `kind` text NOT NULL, `payload` text NOT NULL, `state` text NOT NULL, `error` text, `time_created` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `superagent_action_pending_idx` ON `superagent_action` (`state`, `time_created`);
--> statement-breakpoint
CREATE TABLE `superagent_event` (`id` integer PRIMARY KEY AUTOINCREMENT, `ticket_id` text NOT NULL REFERENCES `superagent_ticket` (`id`), `kind` text NOT NULL, `summary` text NOT NULL, `revision` integer NOT NULL, `candidate_id` text, `time_created` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `superagent_event_ticket_idx` ON `superagent_event` (`ticket_id`, `id`);
--> statement-breakpoint
CREATE TABLE `superagent_state` (`id` text PRIMARY KEY, `router_session_id` text, `cursor` text, `enabled` integer NOT NULL DEFAULT false);
