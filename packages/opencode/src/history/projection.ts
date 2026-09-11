import { sql } from "drizzle-orm"
import { PartTable } from "../session/session.sql"

// Project in SQLite so unused media and metadata never cross the driver boundary.
export function projection(output = true, error = true, reasoning = true, text = true, preview = false) {
  const field = (path: string) => {
    const value = sql`json_extract(${PartTable.data}, ${path})`
    if (!preview) return value
    return sql`CASE WHEN length(CAST(${value} AS BLOB)) > 4000 THEN '[large field omitted; use history get part_id]' ELSE ${value} END`
  }
  return {
    id: PartTable.id,
    message_id: PartTable.message_id,
    session_id: PartTable.session_id,
    time_created: PartTable.time_created,
    data: sql<string>`json_object(
      'type', json_extract(${PartTable.data}, '$.type'),
      'text', CASE WHEN (json_extract(${PartTable.data}, '$.type') = 'text' AND ${Number(text)}) OR (json_extract(${PartTable.data}, '$.type') = 'reasoning' AND ${Number(reasoning)}) THEN ${field("$.text")} END,
      'tool', json_extract(${PartTable.data}, '$.tool'),
      'state', json_object(
        'status', json_extract(${PartTable.data}, '$.state.status'),
        'input', ${field("$.state.input")},
        'output', CASE WHEN ${Number(output)} THEN ${field("$.state.output")} END,
        'error', CASE WHEN ${Number(error)} THEN ${field("$.state.error")} END
      ))`.mapWith((value: string) => JSON.parse(value) as typeof PartTable.$inferSelect.data),
  }
}
