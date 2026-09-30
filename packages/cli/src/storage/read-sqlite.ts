// Runtime-agnostic read-only SQLite reader for external databases (e.g. opencode.db).
// The concrete implementation is selected by the "#read-sqlite" conditional import
// in package.json — bun:sqlite under Bun, node:sqlite under Node/Electron.
export type ReadonlyDb = {
  all: (sql: string, ...params: unknown[]) => unknown[]
  get: (sql: string, ...params: unknown[]) => unknown
  close: () => void
}

export { openReadonly } from "#read-sqlite"
