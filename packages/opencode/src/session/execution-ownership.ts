import { Effect } from "effect"
import { InstanceState } from "@/effect"
import type { WorkspaceID } from "@/control-plane/schema"
import { Database, eq } from "@/storage"
import type { SessionID } from "./schema"
import { SessionTable } from "./session.sql"

export interface Identity {
  readonly directory: string
  readonly workspaceID?: WorkspaceID
}

export class OwnershipError extends Error {
  constructor(readonly sessionID: SessionID, readonly identity: Identity) {
    super(`Session execution is not owned by the current instance: ${sessionID}`)
    this.name = "OwnershipError"
  }
}

export const captureIdentity: Effect.Effect<Identity> = Effect.gen(function* () {
  const directory = yield* InstanceState.directory
  const workspaceID = yield* InstanceState.workspaceID
  return { directory, workspaceID }
})

export function isOwned(db: Database.TxOrDb, sessionID: SessionID, identity: Identity): boolean {
  const session = db.select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
    .from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
  if (!session) return false
  return session.workspaceID !== null
    ? session.workspaceID === identity.workspaceID
    : identity.workspaceID === undefined && session.directory === identity.directory
}

export function assertOwnership(db: Database.TxOrDb, sessionID: SessionID, identity: Identity): void {
  if (!isOwned(db, sessionID, identity)) throw new OwnershipError(sessionID, identity)
}

export * as ExecutionOwnership from "./execution-ownership"
