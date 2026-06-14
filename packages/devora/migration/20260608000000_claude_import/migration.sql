CREATE TABLE `claude_import` (
  `source_uuid` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `source_path` text NOT NULL,
  `source_mtime` integer NOT NULL,
  `time_imported` integer NOT NULL
);
