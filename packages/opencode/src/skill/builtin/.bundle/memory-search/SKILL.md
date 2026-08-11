---
name: "memory-search"
description: "Query the raw trajectory SQLite database directly when the built-in memory and history tools are insufficient. Use when you need structured analysis across sessions: finding repeated errors, grouping tool calls by pattern, verifying what was actually executed, or locating specific past commands/decisions that text search cannot surface. Provides the database schema, ready-to-use SQL query templates, and per-goal strategies."
---

# Memory Search: SQLite Trajectory Database

Direct SQL access to mimocode's trajectory database for structured analysis that the `memory` (BM25 over curated markdown) and `history` (FTS over raw messages) tools cannot perform — aggregation, filtering by tool/status/time, cross-session pattern detection, and execution chain inspection.

## When to use

- You need to **aggregate or count** across sessions (e.g. "which tool fails most often?", "how many sessions touched file X?").
- You need to **filter by structure** — tool name, status, agent_id, time range — not just text content.
- You need to **view a complete execution chain** for a session (every tool call in order).
- You need to **verify a memory claim** against what actually happened (the DB is the source of truth).
- The `memory` and `history` tools returned nothing useful despite multiple query attempts.

## Locating the database

```bash
# Typically at this path. MIMOCODE_DB env var overrides if set.
sqlite3 -readonly ~/.local/share/mimocode/mimocode.db ".tables"
```

Always use `-readonly` or only SELECT queries — never modify the database.

## Schema

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `session` | Session metadata | `id`, `project_id`, `title`, `time_created`, `parent_id` |
| `message` | User/assistant turns | `id`, `session_id`, `agent_id`, `time_created`, `data` (JSON: `$.role`) |
| `part` | Message parts (text, tool calls, steps) | `id`, `message_id`, `session_id`, `time_created`, `data` (JSON) |
| `task` | Task tree | `id`, `session_id`, `summary`, `status` |
| `task_event` | Task state transitions | `id`, `session_id`, `task_id`, `at`, `kind`, `summary` |
| `actor_registry` | Subagent/peer history | `session_id`, `actor_id`, `agent`, `mode`, `status`, `description` |

### Part types in `part.data`

- `{"type":"text","text":"..."}` — agent text output
- `{"type":"tool","tool":"<name>","callID":"...","state":{"status":"completed","input":{...},"output":"..."}}` — completed tool call
- `{"type":"tool","tool":"<name>","callID":"...","state":{"status":"error","input":{...},"error":"..."}}` — failed tool call (no `output` field; error message in `$.state.error`)
- `{"type":"step-start"}` / `{"type":"step-finish","tokens":...}` — step boundaries
- `{"type":"compaction","auto":true/false}` — compaction boundary
- `{"type":"checkpoint",...}` — checkpoint/rebuild boundary

### Key conventions

- `agent_id = 'main'` = main agent; other values = subagent (e.g. `"explore-1"`, `"general-1"`).
- `$.state.output` only exists when `$.state.status = "completed"`. Failures store the message in `$.state.error`.
- `time_created` is Unix milliseconds.

## Query templates

**List recent sessions for this project:**

```sql
SELECT id, title, time_created,
       datetime(time_created/1000, 'unixepoch', 'localtime') as created
FROM session
WHERE project_id = '<PROJECT_ID>'
  AND parent_id IS NULL
ORDER BY time_created DESC
LIMIT 20;
```

**Find user messages containing a keyword:**

```sql
SELECT m.session_id, m.id,
       substr(json_extract(p.data, '$.text'), 1, 200) as preview
FROM message m
JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
WHERE json_extract(m.data, '$.role') = 'user'
  AND json_extract(p.data, '$.type') = 'text'
  AND json_extract(p.data, '$.text') LIKE '%keyword%'
ORDER BY m.time_created DESC
LIMIT 10;
```

**Find tool calls by tool name:**

```sql
SELECT m.session_id, m.id, m.agent_id,
       json_extract(p.data, '$.tool') as tool,
       json_extract(p.data, '$.state.status') as status,
       substr(COALESCE(json_extract(p.data, '$.state.output'), json_extract(p.data, '$.state.error')), 1, 300) as result_preview
FROM message m
JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
WHERE json_extract(m.data, '$.role') = 'assistant'
  AND json_extract(p.data, '$.type') = 'tool'
  AND json_extract(p.data, '$.tool') = '<TOOL_NAME>'
  AND m.session_id = '<SESSION_ID>'
ORDER BY m.time_created DESC
LIMIT 20;
```

**View a session's full execution chain:**

```sql
SELECT m.id, m.agent_id,
       json_extract(p.data, '$.type') as part_type,
       json_extract(p.data, '$.tool') as tool,
       substr(p.data, 1, 800) as preview
FROM message m
JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
WHERE m.session_id = '<SESSION_ID>'
  AND json_extract(m.data, '$.role') = 'assistant'
ORDER BY m.time_created, p.time_created;
```

**Find repeated stdout errors (completed bash calls, last 7 days):**

```sql
SELECT substr(json_extract(p.data, '$.state.output'), 1, 200) as error_output,
       COUNT(*) as occurrences,
       GROUP_CONCAT(DISTINCT m.session_id) as sessions
FROM part p
JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
WHERE json_extract(p.data, '$.type') = 'tool'
  AND json_extract(p.data, '$.tool') = 'bash'
  AND json_extract(p.data, '$.state.status') = 'completed'
  AND json_extract(p.data, '$.state.output') LIKE '%error%'
  AND m.time_created > (strftime('%s', 'now') - 7*86400) * 1000
GROUP BY substr(json_extract(p.data, '$.state.output'), 1, 200)
HAVING occurrences > 1
ORDER BY occurrences DESC
LIMIT 10;
```

**Find actual tool failures (any tool, last 7 days):**

```sql
SELECT json_extract(p.data, '$.tool') as tool,
       substr(json_extract(p.data, '$.state.error'), 1, 200) as error_msg,
       COUNT(*) as occurrences,
       GROUP_CONCAT(DISTINCT m.session_id) as sessions
FROM part p
JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
WHERE json_extract(p.data, '$.type') = 'tool'
  AND json_extract(p.data, '$.state.status') = 'error'
  AND m.time_created > (strftime('%s', 'now') - 7*86400) * 1000
GROUP BY json_extract(p.data, '$.tool'), substr(json_extract(p.data, '$.state.error'), 1, 200)
HAVING occurrences > 1
ORDER BY occurrences DESC
LIMIT 10;
```

## Search strategies

| Goal | Strategy |
|------|----------|
| Find a user's stated rule/preference | Search user text parts for `'%always%'`, `'%never%'`, `'%remember%'`, `'%rule%'` |
| Find a design decision | Search `'%decided%'`, `'%tradeoff%'`, `'%reason%'` in user text |
| Find a specific file path or command | LIKE match on tool output/error |
| Find repeated workflows | Group tool call sequences by session, look for recurring tool×N patterns |
| Verify a memory claim | Find the session_id from the memory entry `[ses_xxx]`, then query its full execution chain |
| Count tool usage | `GROUP BY json_extract(p.data, '$.tool')` with COUNT |

## Constraints

- **Read-only**: Never modify the database. Always `sqlite3 -readonly` or SELECT only.
- **Performance**: The DB can be multi-GB. Always use LIMIT and filter by `session_id` or `time_created` range.
- **Privacy**: Raw trajectory contains everything the user typed. Treat it with care.
- **JSON access**: Part data is JSON-in-a-column. Always use `json_extract()` for structured field access.
