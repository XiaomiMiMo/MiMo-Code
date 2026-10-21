ALTER TABLE `actor_registry` ADD `source_session_id` text;
--> statement-breakpoint
ALTER TABLE `actor_registry` ADD `source_call_id` text;
--> statement-breakpoint
ALTER TABLE `actor_registry` ADD `source_turn_id` text;
--> statement-breakpoint
ALTER TABLE `actor_registry` ADD `execution_generation` integer;
--> statement-breakpoint
ALTER TABLE `task` ADD `source_call_id` text;
