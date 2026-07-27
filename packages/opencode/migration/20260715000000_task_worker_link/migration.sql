-- task: durable link from a task to the WORKER session executing it, plus the
-- dispatch timestamp and a pointer to the outcome. All nullable so existing
-- rows backfill to NULL (mirrors the `owner` column precedent).
ALTER TABLE `task` ADD COLUMN `worker_session_id` text;
--> statement-breakpoint
ALTER TABLE `task` ADD COLUMN `dispatched_at` integer;
--> statement-breakpoint
ALTER TABLE `task` ADD COLUMN `result_ref` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `task_worker_idx` ON `task` (`worker_session_id`,`status`);
