import { Effect } from "effect"
import { eq, Database } from "../storage"
import { SessionTable } from "../session/session.sql"
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
  projectID: (sessionID: string) => Effect.Effect<string>
}

export function makeResolver(): Resolver {
  const projectCache = new LRU<string, string>(512)

  return {
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
