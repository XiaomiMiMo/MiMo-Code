import path from "path"
import type * as Tool from "./tool"
import { SessionCwd } from "./session-cwd"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { RecoverableError } from "./recoverable"
import { registerDisposer } from "@/effect/instance-registry"
import { Instance } from "@/project/instance"
import type { SessionID } from "../session/schema"

const MAIN_ACTOR_ID = "main"
type ReadContext = Pick<Tool.Context, "sessionID" | "actorID">

// Per actor, group read paths by the instance directory that owns them. A
// session can span several directories, and keeping the directory below the
// actor level avoids overwriting marks if an actor ever reads in more than one.
type ActorReads = Map<string | undefined, Set<string>>
const readState = new Map<SessionID, Map<string, ActorReads>>()

// A server can host several project instances at once, and disposeInstance()
// runs every disposer with the directory being torn down. Drop only the marks
// owned by that directory; clearing more would wipe other projects' (or, on a
// shared session, other actors') live marks and make their next edit fail
// "has not been read".
registerDisposer(async (directory) => {
  for (const [sessionID, actors] of readState) {
    for (const [actor, readsByDirectory] of actors) {
      readsByDirectory.delete(directory)
      if (readsByDirectory.size === 0) actors.delete(actor)
    }
    if (actors.size === 0) readState.delete(sessionID)
  }
})

function canon(sessionID: SessionID, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(SessionCwd.get(sessionID), p)
  const resolved = AppFileSystem.resolve(abs)
  if (process.platform === "win32") return resolved.toLowerCase()
  return resolved
}

function actorID(ctx: ReadContext) {
  return ctx.actorID ?? MAIN_ACTOR_ID
}

function sessionActors(sessionID: SessionID) {
  const existing = readState.get(sessionID)
  if (existing) return existing

  const next = new Map<string, ActorReads>()
  readState.set(sessionID, next)
  return next
}

function actorReads(ctx: ReadContext) {
  const actors = sessionActors(ctx.sessionID)
  const existing = actors.get(actorID(ctx))
  if (existing) return existing

  const next: ActorReads = new Map()
  actors.set(actorID(ctx), next)
  return next
}

export function markFileRead(ctx: ReadContext, targetPath: string): void {
  const reads = actorReads(ctx)
  const target = canon(ctx.sessionID, targetPath)
  const directory = Instance.directoryOrUndefined
  const existing = reads.get(directory)
  if (existing) {
    existing.add(target)
    return
  }

  reads.set(directory, new Set([target]))
}

export function clearReadState(sessionID?: SessionID): void {
  if (!sessionID) {
    readState.clear()
    return
  }
  readState.delete(sessionID)
}

/**
 * Throws RecoverableError if the given file was not previously read by the
 * `read` tool in this conversation. Writes/edits to existing files must be
 * preceded by a Read so the model sees the current contents — this turns the
 * usage note in edit.txt into actual enforcement.
 *
 * RecoverableError is intentional: the failure is surfaced to the agent as a
 * tool result it can act on (call Read, then retry) rather than as a hard
 * system fault.
 */
export function assertFileRead(ctx: Tool.Context, targetPath: string, toolId: string): void {
  const target = canon(ctx.sessionID, targetPath)
  if ([...(readState.get(ctx.sessionID)?.get(actorID(ctx))?.values() ?? [])].some((paths) => paths.has(target))) return

  for (const msg of ctx.messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.tool !== "read") continue
      if (part.state.status !== "completed") continue
      const input = part.state.input as { file_path?: unknown } | undefined
      const fp = input?.file_path
      if (typeof fp !== "string") continue
      if (canon(ctx.sessionID, fp) === target) return
    }
  }

  throw new RecoverableError(
    `${toolId}: ${targetPath} has not been read in this conversation. Call the read tool on this file first, then retry.`,
  )
}
