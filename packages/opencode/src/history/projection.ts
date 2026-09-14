import { sql } from "drizzle-orm"
import { PartTable } from "../session/session.sql"

// Project in SQLite so unused media and metadata never cross the driver boundary.
export function projection(preview = false) {
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
      'text', ${field("$.text")},
      'filename', json_extract(${PartTable.data}, '$.filename'),
      'mime', json_extract(${PartTable.data}, '$.mime'),
      'tool', json_extract(${PartTable.data}, '$.tool'),
      'state', json_object(
        'status', json_extract(${PartTable.data}, '$.state.status'),
        'input', ${field("$.state.input")},
        'output', ${field("$.state.output")},
        'error', ${field("$.state.error")},
        'attachments', json((SELECT json_group_array(json_object('filename', json_extract(value, '$.filename'), 'mime', json_extract(value, '$.mime'))) FROM json_each(${PartTable.data}, '$.state.attachments')))
      ))`.mapWith((value: string) => JSON.parse(value) as typeof PartTable.$inferSelect.data),
  }
}
