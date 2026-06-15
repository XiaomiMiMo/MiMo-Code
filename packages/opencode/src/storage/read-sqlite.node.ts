import { DatabaseSync } from "node:sqlite"
import type { ReadonlyDb } from "./read-sqlite"

// 参数用 `never[]` 转型:node:sqlite 不同版本对绑定值的导出类型名不一致
// (SupportedValueType / SQLInputValue 等),never 可赋给任意元组形参,避免依赖具体导出名。
export function openReadonly(path: string): ReadonlyDb {
  const db = new DatabaseSync(path, { readOnly: true })
  return {
    all: (sql, ...params) => db.prepare(sql).all(...(params as never[])) as unknown[],
    get: (sql, ...params) => (db.prepare(sql).get(...(params as never[])) ?? null) as unknown,
    close: () => db.close(),
  }
}
