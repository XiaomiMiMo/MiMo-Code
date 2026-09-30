-- todo: drop priority column
ALTER TABLE `todo` DROP COLUMN `priority`;
--> statement-breakpoint

-- task: drop focus-dependent index before dropping its column
DROP INDEX `task_focus_per_session_idx`;
--> statement-breakpoint
DROP INDEX `task_kind_idx`;
--> statement-breakpoint
ALTER TABLE `task` DROP COLUMN `focus`;
--> statement-breakpoint
ALTER TABLE `task` DROP COLUMN `kind`;
--> statement-breakpoint

-- migrate status values: proposed/active -> open
UPDATE `task` SET `status` = 'open' WHERE `status` IN ('proposed', 'active');
