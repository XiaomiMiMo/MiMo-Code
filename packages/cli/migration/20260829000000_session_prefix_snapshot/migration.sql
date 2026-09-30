CREATE TABLE `session_prefix_snapshot` (
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `profile_key` text NOT NULL,
  `system` text NOT NULL,
  `system_hash` text NOT NULL,
  `tools_hash` text NOT NULL,
  `watermark_message_id` text NOT NULL,
  `revision` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`session_id`, `profile_key`)
);
