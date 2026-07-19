# Print Mode Deep Dive

## Structured JSON Output

```
terminal(command="claude -p 'Analyze auth.py for security issues' --output-format json --max-turns 5", workdir="/project", timeout=120)
```

Returns:

```json
{
  "type": "result",
  "subtype": "success",
  "result": "The analysis text...",
  "session_id": "75e2167f-...",
  "num_turns": 3,
  "total_cost_usd": 0.0787,
  "duration_ms": 10276,
  "stop_reason": "end_turn",
  "terminal_reason": "completed",
  "usage": { "input_tokens": 5, "output_tokens": 603 },
  "modelUsage": { "claude-sonnet-4-6": { "costUSD": 0.078, "contextWindow": 200000 } }
}
```

Key fields: `session_id` (resumption), `num_turns` (loop count), `total_cost_usd` (spend), `subtype` (`success` / `error_max_turns` / `error_budget`).

## Streaming JSON

```
claude -p 'Write a summary' --output-format stream-json --verbose --include-partial-messages
```

Newline-delimited JSON events. Live text via jq:

```
... | jq -rj 'select(.type == "stream_event" and .event.delta.type? == "text_delta") | .event.delta.text'
```

- Stream includes `system/api_retry` events with `attempt`, `max_retries`, `error` (`rate_limit`, `billing_error`).
- Add `--include-hook-events` to observe hook lifecycle (stream-json only).

## Bidirectional Streaming

```
claude -p "task" --input-format stream-json --output-format stream-json --replay-user-messages
```

`--replay-user-messages` re-emits user messages on stdout for acknowledgment.

## Piped Input

```
cat src/auth.py | claude -p 'Review this code for bugs' --max-turns 1
cat src/*.py    | claude -p 'Find all TODO comments' --max-turns 1
git diff HEAD~3 | claude -p 'Summarize these changes' --max-turns 1
```

Prefer piping over having Claude read files when you just need analysis of known content (cheaper).

## JSON Schema Extraction

```
claude -p 'List all functions in src/' --output-format json \
  --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}},"required":["functions"]}' \
  --max-turns 5
```

Parse `structured_output` from the result. Output is validated against the schema before returning. Needs enough `--max-turns` for Claude to read files first.

## Session Management

```bash
# capture session_id from a first run, then:
claude -p 'Continue and add connection pooling' --resume <session_id> --max-turns 5
claude -p 'What did you do last time?' --continue --max-turns 1        # latest session in this cwd
claude -p 'Try a different approach' --resume <id> --fork-session      # new ID, keeps history
claude -p 'task' --session-id 550e8400-e29b-41d4-a716-446655440000     # pin a UUID
claude -p 'task' --no-session-persistence                              # CI: don't save to disk
```

Resumption requires the same working directory.

## Bare Mode (CI/Scripting)

```
claude --bare -p 'Run all tests and report failures' --allowedTools 'Read,Bash' --max-turns 10
```

`--bare` skips hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets `CLAUDE_CODE_SIMPLE=1`. Auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth/keychain never read). Third-party providers (Bedrock/Vertex/Foundry) use their own credentials. Skills still resolve via `/skill-name`.

Selective context loading in bare mode:

| To load | Flag |
|---|---|
| System prompt additions | `--append-system-prompt "text"` |
| Full system prompt override | `--system-prompt "text"` |
| Extra working dirs (+their CLAUDE.md) | `--add-dir <paths...>` |
| Settings | `--settings <file-or-json>` |
| MCP servers | `--mcp-config <file-or-json>` (+ `--strict-mcp-config`) |
| Custom agents | `--agents '<json>'` |
| Plugins (session-only) | `--plugin-dir <path>` / `--plugin-url <url>` |

For rock-bottom troubleshooting prefer `--safe-mode` (v2.1.169+, disables all customizations).

## Multi-User Cache Reuse

```
claude -p --exclude-dynamic-system-prompt-sections "task"
```

Moves per-machine sections (cwd, env, memory paths, git status) into the first user message → better cross-user prompt-cache hits. Only applies with the default system prompt.

## Overload Fallback

```
claude -p 'task' --fallback-model haiku --max-turns 5
```

Auto-falls back when the default model is overloaded (print mode only).

## Cost & Performance Checklist

1. `--max-turns` 5–10 to prevent runaway loops (print-mode only).
2. `--max-budget-usd` for caps — minimum ~$0.05 (system-prompt cache creation costs this).
3. `--effort low` for simple tasks; `high`/`xhigh`/`max` for complex; `ultracode` for high-effort codegen.
4. `--bare` in CI to skip plugin/hook discovery overhead.
5. `--allowedTools` least-privilege (e.g. `Read` only for reviews).
6. `--exclude-dynamic-system-prompt-sections` in scripted multi-user runs.
7. Pipe input instead of file reads for known content.
8. `--model haiku` for cheap tasks, `opus` for complex multi-step.
9. Fresh sessions per distinct task — sessions last 5 hours; fresh context is more efficient.
10. `--no-session-persistence` in CI to avoid disk accumulation.

## Known Quirk

Python binary name mismatch: Linux/macOS often lack a `python` symlink (only `python3`); Windows is the inverse (`python`/`py`, no `python3`). Claude's first attempt may fail, then self-corrects — costs one turn. PowerShell command translation for all recipes in this file → `references/platforms.md`.
