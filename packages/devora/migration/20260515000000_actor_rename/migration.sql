DROP INDEX IF EXISTS `task_registry_parent_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `task_registry_status_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `task_registry_status_last_turn_idx`;--> statement-breakpoint
ALTER TABLE `task_registry` RENAME TO `actor_registry`;--> statement-breakpoint
CREATE INDEX `actor_registry_parent_idx` ON `actor_registry` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `actor_registry_status_idx` ON `actor_registry` (`status`);--> statement-breakpoint
CREATE INDEX `actor_registry_status_last_turn_idx` ON `actor_registry` (`status`, `last_turn_time`);
