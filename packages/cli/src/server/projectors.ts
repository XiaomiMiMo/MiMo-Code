import z from "zod"
import sessionProjectors from "../session/projectors"
import { projectors as inboxProjectors } from "../inbox/sync"
import { SyncEvent } from "@/sync"
import { Session } from "@/session"
import { SessionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage"

export function initProjectors() {
  SyncEvent.init({
    projectors: [...sessionProjectors, ...inboxProjectors],
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        const id = (data as z.infer<typeof Session.Event.Updated.schema>).sessionID
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())

        if (!row) return data

        return {
          sessionID: id,
          info: Session.fromRow(row),
        }
      }
      return data
    },
  })
}

initProjectors()
