CREATE TABLE `permission_grant` (
  `parent_session_id` text NOT NULL,
  `target` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY(`parent_session_id`, `target`)
);
