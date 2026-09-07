ALTER TABLE session ADD COLUMN title_source text NOT NULL DEFAULT 'user' CHECK (title_source IN ('fallback', 'generated', 'user'));
--> statement-breakpoint
ALTER TABLE session ADD COLUMN title_revision integer NOT NULL DEFAULT 0 CHECK (typeof(title_revision) = 'integer' AND title_revision >= 0 AND title_revision <= 9007199254740991);
--> statement-breakpoint
UPDATE session SET title = 'Untitled', title_source = 'fallback' WHERE trim(title) = '';
--> statement-breakpoint
CREATE TRIGGER session_title_transition_guard BEFORE UPDATE OF title, title_source, title_revision ON session
-- Only the replay-only v1 projector uses the protected revision-zero baseline.
-- New title commands/projectors always require next = previous + 1.
WHEN (NEW.title_revision != OLD.title_revision + 1 AND NOT (OLD.title_revision = 0 AND NEW.title_revision = 0 AND NEW.title_source = 'user'))
  OR (OLD.title_source = 'user' AND NEW.title_source != 'user')
  OR (OLD.title_source = 'generated' AND NEW.title_source != 'user')
BEGIN SELECT RAISE(ABORT, 'invalid session title transition'); END;
