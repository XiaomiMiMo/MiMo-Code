CREATE TABLE `external_import` (
  `source` text NOT NULL,
  `source_key` text NOT NULL,
  `session_id` text NOT NULL,
  `source_path` text NOT NULL,
  `source_mtime` integer NOT NULL,
  `time_imported` integer NOT NULL,
  `message_ids` text,
  PRIMARY KEY (`source`, `source_key`)
);

INSERT INTO `external_import` (`source`, `source_key`, `session_id`, `source_path`, `source_mtime`, `time_imported`, `message_ids`)
SELECT 'cc', `source_uuid`, `session_id`, `source_path`, `source_mtime`, `time_imported`, `message_ids`
FROM `claude_import`;

DROP TABLE `claude_import`;
