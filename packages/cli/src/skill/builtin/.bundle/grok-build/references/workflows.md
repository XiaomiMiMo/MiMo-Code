# Grok Build CLI Workflows

Use these patterns as starting points, then confirm flags with the installed CLI.

## Headless Automation

Run one unattended analysis with workspace-scoped writes:

```bash
grok --no-auto-update \
  --cwd /workspace/repo \
  --sandbox workspace \
  -p "Implement the requested change and run relevant tests." \
  --output-format json
```

Use `streaming-json` for progress consumers. Use `json` when only the final result matters. Keep stderr separate if downstream code parses stdout.

For structured output, first verify `--json-schema` with `grok --help`, then pass a compact JSON Schema directly or through the caller's safe argument mechanism.

Official source: <https://docs.x.ai/build/cli/headless-scripting>

## Sessions

Resume the most recent session for a directory:

```bash
grok --cwd /workspace/repo --continue
```

Resume a known session:

```bash
grok --cwd /workspace/repo --resume <session-id>
```

Create a new session with a caller-supplied UUID:

```bash
grok --cwd /workspace/repo --session-id <uuid> -p "Start the task"
```

Do not use `--session-id` to resume. Use `--fork-session` with `--resume` or `--continue` to branch the conversation instead of modifying the original session.

Official source: <https://docs.x.ai/build/features/sessions>

## Worktree Isolation

Start isolated work from a known ref:

```bash
grok --cwd /workspace/repo --worktree --ref main "Fix the flaky test"
```

List and inspect worktrees before cleanup:

```bash
grok worktree list
grok worktree show <id>
grok worktree rm --dry-run <id>
```

Worktrees persist after sessions end. Use `grok worktree gc` only after understanding its age and liveness criteria.

Official source: <https://docs.x.ai/build/features/worktrees>

## Permissions and Sandbox

Use a read-only profile for repository review:

```bash
grok --cwd /workspace/repo \
  --sandbox read-only \
  -p "Review the repository without modifying files."
```

Use a strict profile for an untrusted tree:

```bash
grok --cwd /workspace/untrusted \
  --sandbox strict \
  -p "Inspect this repository and report risks."
```

Add narrow `--allow <RULE>` and `--deny <RULE>` options only after confirming the installed rule syntax with `grok --help` and current documentation. Deny rules take precedence over allow rules. Sandbox profiles control filesystem and child-process network scope after a tool call is approved; they do not replace permission decisions.

Built-in profiles include `off`, `workspace`, `devbox`, `read-only`, and `strict`. The sandbox is off by default. Child-network restrictions for `read-only` and `strict` are not enforced on macOS, so do not rely on them there as a network security boundary.

Official sources:

- <https://docs.x.ai/build/features/permissions>
- <https://docs.x.ai/build/features/sandbox>

## MCP Servers

Add a local stdio server:

```bash
grok mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /path/to/dir
```

Add a remote HTTP server:

```bash
grok mcp add --transport http linear https://mcp.linear.app/mcp
```

Diagnose before changing configuration:

```bash
grok mcp list --json
grok mcp doctor
grok inspect --json
```

Pass `--scope project` only when the server configuration should be written to the repository's `.grok/config.toml`. Keep static tokens in environment variables; avoid putting secret values directly in command history or committed files.

Official source: <https://docs.x.ai/build/features/mcp-servers>
