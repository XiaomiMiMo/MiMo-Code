import { Effect } from "effect"
import { eq, Database } from "../storage"
import { MessageTable, SessionTable } from "../session/session.sql"
import type { MessageID } from "../session/schema"
import type { SessionID } from "../session/schema"

class LRU<K, V> {
  private map = new Map<K, V>()
  constructor(private readonly max: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k)
    if (v === undefined) return undefined
    this.map.delete(k)
    this.map.set(k, v)
    return v
  }
  set(k: K, v: V) {
    if (this.map.has(k)) this.map.delete(k)
    this.map.set(k, v)
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }
}

export type Resolver = {
  role: (messageID: string) => Effect.Effect<"user" | "assistant">
  projectID: (sessionID: string) => Effect.Effect<string>
}

export function makeResolver(): Resolver {
  const roleCache = new LRU<string, "user" | "assistant">(1024)
  const projectCache = new LRU<string, string>(512)

  return {
    role: (messageID) =>
      Effect.sync(() => {
        const cached = roleCache.get(messageID)
        if (cached) return cached
        const row = Database.use((db) =>
          db.select({ data: MessageTable.data }).from(MessageTable).where(eq(MessageTable.id, messageID as MessageID)).get(),
        )
        const role = (row?.data as { role?: string } | undefined)?.role === "user" ? "user" : "assistant"
        roleCache.set(messageID, role)
        return role
      }),

    projectID: (sessionID) =>
      Effect.sync(() => {
        const cached = projectCache.get(sessionID)
        if (cached) return cached
        const row = Database.use((db) =>
          db
            .select({ project_id: SessionTable.project_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID as SessionID))
            .get(),
        )
        const projectID = row?.project_id ?? ""
        projectCache.set(sessionID, projectID)
        return projectID
      }),
  }
}
