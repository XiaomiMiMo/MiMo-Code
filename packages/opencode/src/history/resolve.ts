import { eq, Database } from "../storage"
import { SessionTable } from "../session/session.sql"
import { SessionID } from "../session/schema"

export type Resolver = {
  projectID: (sessionID: string, db: Database.TxOrDb) => string | undefined
}

export function makeResolver(): Resolver {
  return {
    projectID: (sessionID, db) =>
      db
        .select({ project_id: SessionTable.project_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(sessionID)))
        .get()?.project_id,
  }
}
