---
name: grok-build
description: Reference and workflow guidance for the Grok Build CLI (`grok`), including interactive and headless runs, authentication, sessions, worktrees, permissions, sandboxing, MCP servers, plugins, inspection, updates, and automation output. Invoke only when the user explicitly requests the `grok-build` skill, explicitly asks to use Grok Build CLI, or an already-selected workflow requires Grok Build; do not invoke for general coding, generic shell tasks, or other agent CLIs.
---

# Grok Build CLI

Operate Grok Build from a terminal while keeping execution mode, permissions, sandboxing, session state, and output handling explicit.

## Start with Local Evidence

1. Confirm that the CLI is available:

   ```bash
   command -v grok
   grok version
   ```

2. Inspect the installed command before giving version-sensitive advice:

   ```bash
   grok --help
   grok <subcommand> --help
   ```

3. Inspect the configuration discovered for the target workspace when behavior depends on rules, skills, plugins, hooks, or MCP servers:

   ```bash
   grok --cwd /path/to/repo inspect
   grok --cwd /path/to/repo inspect --json
   ```

4. Treat current official documentation and installed help as authoritative when they differ from this bundled reference.

## Choose an Execution Mode

- Run `grok` with no arguments for the interactive TUI.
- Run `grok "<initial prompt>"` to open the TUI with an initial task.
- Run `grok -p "<prompt>"` for one non-interactive turn that prints a result and exits.
- Run `grok agent stdio` for an ACP client that communicates over stdin/stdout.
- Run `grok dashboard` to open the Agent Dashboard.

Prefer headless mode for scripts, CI, bots, and agent orchestration. Prefer ACP only when the caller implements the ACP JSON-RPC lifecycle and consumes `session/update` chunks.

## Authenticate

Use an interactive login on a developer machine:

```bash
grok login
```

Use device-code authentication in headless or remote environments:

```bash
grok login --device-auth
```

Use a locally cached login or provide `XAI_API_KEY` only to the process that needs it. Never print, persist, or commit credentials. Use `grok logout` to clear cached credentials.

## Run Headlessly

Use an explicit working directory and output format:

```bash
grok --no-auto-update \
  --cwd /path/to/repo \
  --sandbox workspace \
  -p "Inspect the repository and explain the failing test." \
  --output-format json
```

Choose output according to the consumer:

- Use `plain` for humans.
- Use `json` for one final machine-readable object.
- Use `streaming-json` for newline-delimited incremental events.
- Add `--json-schema '<schema>'` when the installed CLI supports constrained structured output.

Pass `--no-auto-update` in scripts and CI to suppress background update checks. Do not parse interactive TUI rendering in automation.

## Control Permissions and Isolation

Treat permissions and sandboxing as separate controls:

- Use permission rules to decide whether a tool call may run.
- Use a sandbox profile to limit what an approved call may access.
- Prefer `--sandbox workspace` for normal repository changes.
- Prefer `--sandbox read-only` for review and auditing.
- Prefer `--sandbox strict` for an untrusted repository, then add narrow permission rules.
- Use `--allow <RULE>` and `--deny <RULE>` for per-run policy; remember that deny rules win.
- Use `--always-approve` only when the environment and command scope justify unattended execution. Pair it with a suitable sandbox and explicit deny rules.

Do not describe `--always-approve` as equivalent to sandboxing. The sandbox is off by default unless configured or selected.

## Manage Sessions and Worktrees

Continue or resume intentionally:

```bash
grok -c
grok --resume <session-id>
grok --resume
```

Use `--session-id <UUID>` for a new named session, not to resume an existing one. Add `--fork-session` when branching from a resumed session.

Use a worktree when concurrent work could collide:

```bash
grok --worktree --ref main "Fix the flaky test"
grok --worktree=feature-name "Implement the feature"
```

Preview removal with `grok worktree rm --dry-run <id>` before deleting a worktree. Do not assume deleting a session removes its worktree.

## Diagnose Before Editing Configuration

Use built-in inspection and diagnostics first:

```bash
grok inspect --json
grok mcp list --json
grok mcp doctor
grok plugin list
grok models
```

Prefer `grok mcp add`, `grok mcp remove`, and plugin subcommands over manually editing configuration when the CLI supports the requested operation. Keep secrets in environment variables rather than command history or committed configuration.

## Read the Bundled References

- Read [references/cli-reference.md](references/cli-reference.md) for the subcommand and common flag index.
- Read [references/workflows.md](references/workflows.md) for headless execution, sessions, worktrees, permissions, sandboxing, and MCP examples.

Verify destructive commands such as session deletion, plugin removal, MCP removal, memory clearing, and worktree removal with the user or the governing workflow before running them.
