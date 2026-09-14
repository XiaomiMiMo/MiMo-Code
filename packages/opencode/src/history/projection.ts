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
      'url', CASE WHEN lower(substr(json_extract(${PartTable.data}, '$.url'), 1, 5)) != 'data:' THEN ${field("$.url")} END,
      'source', ${field("$.source")},
      'prompt', ${field("$.prompt")},
      'description', ${field("$.description")},
      'agent', ${field("$.agent")},
      'command', ${field("$.command")},
      'name', ${field("$.name")},
      'files', ${field("$.files")},
      'projection', json_object('summary', ${field("$.projection.summary")}, 'manifest', ${field("$.projection.manifest")}),
      'error', json_object('data', json_object('message', ${field("$.error.data.message")}, 'responseBody', ${field("$.error.data.responseBody")})),
      'snapshot', ${field("$.snapshot")},
      'checkpointDir', ${field("$.checkpointDir")},
      'checkpointNumber', ${field("$.checkpointNumber")},
      'coveredUpTo', ${field("$.coveredUpTo")},
      'reason', ${field("$.reason")},
      'cost', ${field("$.cost")},
      'tokens', ${field("$.tokens")},
      'tool', json_extract(${PartTable.data}, '$.tool'),
      'state', json_object(
        'status', json_extract(${PartTable.data}, '$.state.status'),
        'input', ${field("$.state.input")},
        'output', ${field("$.state.output")},
        'error', ${field("$.state.error")},
        'attachments', json((SELECT json_group_array(json_object('filename', json_extract(value, '$.filename'), 'mime', json_extract(value, '$.mime'), 'source', json_extract(value, '$.source'), 'url', CASE WHEN lower(substr(json_extract(value, '$.url'), 1, 5)) != 'data:' THEN json_extract(value, '$.url') END)) FROM json_each(${PartTable.data}, '$.state.attachments')))
      ))`.mapWith((value: string) => JSON.parse(value) as typeof PartTable.$inferSelect.data),
  }
}
