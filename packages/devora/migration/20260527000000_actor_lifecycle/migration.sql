ALTER TABLE `actor_registry` ADD COLUMN `last_outcome` text;--> statement-breakpoint
ALTER TABLE `actor_registry` ADD COLUMN `lifecycle` text NOT NULL DEFAULT 'ephemeral';--> statement-breakpoint
ALTER TABLE `actor_registry` RENAME COLUMN `error` TO `last_error`;--> statement-breakpoint
UPDATE `actor_registry` SET `last_outcome` = 'success' WHERE `status` = 'completed';--> statement-breakpoint
UPDATE `actor_registry` SET `last_outcome` = 'failure' WHERE `status` = 'failed';--> statement-breakpoint
UPDATE `actor_registry` SET `last_outcome` = 'cancelled' WHERE `status` = 'cancelled';--> statement-breakpoint
UPDATE `actor_registry` SET `status` = 'idle' WHERE `status` IN ('completed','failed','cancelled');--> statement-breakpoint
UPDATE `actor_registry` SET `lifecycle` = CASE `mode` WHEN 'peer' THEN 'persistent' WHEN 'main' THEN 'persistent' ELSE 'ephemeral' END;
