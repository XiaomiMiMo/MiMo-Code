DROP TRIGGER IF EXISTS session_title_transition_guard;
--> statement-breakpoint
CREATE TRIGGER session_title_transition_guard BEFORE UPDATE OF title, title_source, title_revision ON session
WHEN (NEW.title_revision != OLD.title_revision + 1 AND NOT (OLD.title_revision = 0 AND NEW.title_revision = 0 AND NEW.title_source = 'user'))
  OR (OLD.title_source = 'user' AND NEW.title_source != 'user')
  OR (OLD.title_source = 'generated' AND NEW.title_source = 'fallback')
BEGIN SELECT RAISE(ABORT, 'invalid session title transition'); END;
