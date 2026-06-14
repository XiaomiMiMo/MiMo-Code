ALTER TABLE `session` ADD `context_from` text;--> statement-breakpoint
ALTER TABLE `session` ADD `context_watermark` text;--> statement-breakpoint
CREATE INDEX `session_context_from_idx` ON `session` (`context_from`);
