import { Database } from "bun:sqlite"
import type { ReadonlyDb } from "./read-sqlite"

export function openReadonly(path: string): ReadonlyDb {
  const db = new Database(path, { readonly: true })
  return {
    all: (sql, ...params) => db.query(sql).all(...(params as never[])) as unknown[],
    get: (sql, ...params) => (db.query(sql).get(...(params as never[])) ?? null) as unknown,
    close: () => db.close(),
  }
}
