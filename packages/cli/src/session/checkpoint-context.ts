import type { SessionID } from "./schema"

export type CheckpointContext = {
  priorTitles: Set<string>
  expectedRevisions: { id: string; expectedText: string }[]
}

const store = new Map<string, CheckpointContext>()

function key(sessionID: SessionID, actorID: string): string {
  return `${sessionID}:${actorID}`
}

export function set(sessionID: SessionID, actorID: string, ctx: CheckpointContext): void {
  store.set(key(sessionID, actorID), ctx)
}

export function get(sessionID: SessionID, actorID: string): CheckpointContext | undefined {
  const ctx = store.get(key(sessionID, actorID))
  if (!ctx) return undefined
  return structuredClone(ctx)
}

export function remove(sessionID: SessionID, actorID: string): void {
  store.delete(key(sessionID, actorID))
}

/** Test-only escape hatch. Resets store between tests. */
export function _reset(): void {
  store.clear()
}

/** Test-only escape hatch. Returns total entry count. */
export function _size(): number {
  return store.size
}
