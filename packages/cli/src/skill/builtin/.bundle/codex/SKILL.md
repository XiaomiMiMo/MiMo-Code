---
name: codex
description: Run, configure, and troubleshoot OpenAI Codex CLI in non-interactive headless environments. Use for Codex automation in Bash or PowerShell, native Windows or WSL2, shell scripts, CI/CD, Docker, Kubernetes, remote servers, agent harnesses, or batch jobs; for constructing `codex exec` commands; selecting sandbox and approval modes; consuming JSONL events or structured output; resuming sessions; passing prompts through stdin; and handling failures caused by unavailable interactive input such as `request_user_input`.
---

# Codex CLI

Use Codex CLI as a deterministic, non-interactive worker suitable for automation and agent orchestration.

## Operating Rules

1. Use `codex exec`, not the interactive `codex` TUI.
2. Pass the task as the positional `PROMPT` argument. Do not use `-p` for the prompt; `-p` selects a profile.
3. For ordinary unattended code changes, prefer:

```bash
codex exec \
  -C /path/to/repo \
  --sandbox workspace-write \
  --ask-for-approval never \
  "<TASK>"
```

4. Use `--yolo` only inside an externally hardened and disposable runner. It disables Codex approvals and sandboxing.
5. For harnesses and CI, prefer `--json` plus `--output-last-message`.
6. Do not make the run depend on a human answering questions. Resolve ambiguity using repository evidence and conservative defaults.
7. Treat credentials as secrets. Inject `CODEX_API_KEY` only into the single `codex exec` process when possible.
8. Before giving version-sensitive advice, inspect `codex exec --help` or current official Codex documentation if available.
9. On Windows, choose one execution environment per task: native PowerShell for Windows toolchains or WSL2 for Linux toolchains. Do not casually mix paths, installations, or authentication across them.

## Choose the Execution Mode

### Read-only analysis

Use when the task must not modify files:

```bash
codex exec \
  -C /path/to/repo \
  --sandbox read-only \
  --ask-for-approval never \
  "Analyze the repository and report risks. Do not modify files."
```

### Workspace-scoped implementation

Use as the default for autonomous repository work:

```bash
codex exec \
  -C /path/to/repo \
  --sandbox workspace-write \
  --ask-for-approval never \
  "Implement the task, run relevant tests, and report unresolved blockers."
```

### Externally isolated unrestricted execution

Use only when the enclosing container, VM, or sandbox enforces the real security boundary:

```bash
codex exec \
  -C /workspace/repo \
  --yolo \
  "Implement the task and validate the result."
```

Never recommend `--yolo` on a normal developer machine or a runner containing unrelated secrets, host mounts, SSH keys, cloud credentials, or a Docker socket.

## Construct an Autonomous Prompt

When headless execution could encounter choices, prepend these instructions:

```text
Work fully autonomously.

Do not ask the user questions and do not request interactive input.
Inspect the repository and available context before making assumptions.
When several valid approaches exist, choose the option that:
1. minimizes unrelated changes,
2. preserves backward compatibility,
3. introduces the fewest new dependencies,
4. avoids destructive or irreversible actions.

Continue until the task is complete or a concrete blocking error is reached.
Record assumptions, validation performed, and unresolved blockers in the final response.
```

Do not simulate "always select the first option." Option ordering is not a safety or quality policy. Apply the explicit decision rules above instead.

## Handle `request_user_input` Failures

When Codex reports that `request_user_input` is unavailable in Default mode or non-interactive mode:

1. Confirm the invocation uses `codex exec` and is intentionally headless.
2. Add the autonomous prompt policy above.
3. Supply missing decisions in the task prompt or `AGENTS.md` when they are known in advance.
4. Replace open-ended requests such as "ask me which approach" with deterministic selection criteria.
5. If the choice is safety-critical, destructive, or impossible to infer, make the run fail clearly rather than selecting randomly.
6. Do not attempt to emulate terminal keystrokes unless the subprocess itself, rather than Codex, requires input and the workflow explicitly defines the safe answer.

## Pass Prompts and Context

Use a direct positional prompt:

```bash
codex exec "Summarize the repository structure."
```

Read the prompt from stdin:

```bash
codex exec - < prompt.md
```

Pipe dynamic context while retaining an explicit task:

```bash
npm test 2>&1 | codex exec "Analyze this test output and fix the repository."
```

Use `--skip-git-repo-check` only for intentional one-off directories outside Git:

```bash
codex exec \
  --skip-git-repo-check \
  -C /tmp/task \
  "Analyze the files in this directory."
```

## Produce Harness-Friendly Output

### Capture only the final message

```bash
codex exec \
  -C /workspace/repo \
  --output-last-message /output/final.md \
  "Review the codebase."
```

### Stream JSONL events

```bash
codex exec \
  -C /workspace/repo \
  --json \
  --sandbox workspace-write \
  --ask-for-approval never \
  "Run tests and fix failures." \
  > /output/events.jsonl
```

Expect event families such as `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`.

### Capture events and the final answer together

```bash
codex exec \
  -C /workspace/repo \
  --json \
  --sandbox workspace-write \
  --ask-for-approval never \
  --output-last-message /output/final.md \
  "Complete the task autonomously." \
  | tee /output/events.jsonl
```

Do not parse human-readable progress text when `--json` is available.

## Require Structured Final Output

Create a JSON Schema and pass it with `--output-schema`:

```bash
codex exec \
  -C /workspace/repo \
  --sandbox workspace-write \
  --ask-for-approval never \
  --output-schema /input/result.schema.json \
  --output-last-message /output/result.json \
  "Implement the task, validate it, and return the requested structured result."
```

A useful harness schema usually includes:

- `status`: `success`, `partial`, or `failed`
- `summary`: concise outcome
- `changed_files`: repository-relative paths
- `validation`: commands run and results
- `assumptions`: decisions made without user input
- `blockers`: concrete unresolved problems

Set `additionalProperties` to `false` when downstream parsing must be strict.

## Resume or Avoid Persistence

Resume the most recent session for the current working directory:

```bash
codex exec resume --last "Continue the previous task and fix remaining issues."
```

Resume a specific session:

```bash
codex exec resume "$SESSION_ID" "Continue with the next stage."
```

Use an ephemeral run when rollout persistence is undesirable:

```bash
codex exec --ephemeral "Analyze the repository."
```

Do not rely on `--last` across unrelated working directories unless deliberately using the relevant all-directory option supported by the installed CLI.

## Authenticate Safely

For a local interactive login:

```bash
codex login
```

For a headless machine with device-code login enabled:

```bash
codex login --device-auth
```

For a single automated invocation:

```bash
CODEX_API_KEY="$OPENAI_API_KEY" \
codex exec --json "Triage the repository."
```

Do not expose API keys as broad job-level environment variables in jobs that execute repository-controlled code. Never commit or print `~/.codex/auth.json`.

## Windows, PowerShell, and WSL2

For native Windows headless use:

- Install with the official PowerShell installer or npm.
- Prefer PowerShell 7.4 or newer for JSONL redirection.
- Build argument arrays and invoke them with `& codex @args`; avoid fragile backtick-heavy command construction.
- Check `$LASTEXITCODE` after every Codex invocation. PowerShell error preferences alone are not a substitute for checking a native process exit code.
- Keep stdout JSONL separate from stderr diagnostics. Do not use `2>&1` when stdout must remain parseable JSONL.
- Configure `%USERPROFILE%\.codex\config.toml` with `[windows] sandbox = "elevated"` when available; use `unelevated` only as the fallback.
- Preserve the task-level policy `--sandbox workspace-write --ask-for-approval never` for ordinary autonomous edits. The native Windows sandbox implementation and the CLI task policy are separate controls.

For WSL:

- Use WSL2, not WSL1.
- Install and authenticate Codex inside WSL as a Linux installation.
- Keep repositories under `~/code/...`, not `/mnt/c/...`, for better performance and fewer permission, symlink, and file-watcher problems.
- Do not pass credentials through visible `wsl.exe` command-line strings.

See [references/windows.md](references/windows.md) for installation, PowerShell wrappers, JSONL parsing, sandbox configuration, WSL2 patterns, and Windows-specific troubleshooting.

## Container and CI Requirements

When generating a Docker, Kubernetes, or CI design:

- Mount only the intended workspace and output directory.
- Run as a non-root user when practical.
- Do not mount the host Docker socket.
- Do not mount home directories, SSH keys, or cloud credential directories.
- Restrict network access unless the task explicitly needs it.
- Apply CPU, memory, process, and execution-time limits outside Codex.
- Preserve stdout, stderr, exit status, JSONL events, and the final message separately.
- Validate repository diffs and test results before treating a run as successful.
- Prefer a fresh worktree or disposable checkout per task.

See [references/recipes.md](references/recipes.md) for ready-to-use shell, Docker, CI, and parser patterns.

## Diagnose Failures

Use this order:

1. Run `codex --version` and `codex exec --help`.
2. Verify the command uses a positional prompt or `-` for stdin.
3. Verify the working directory and Git repository status.
4. Verify authentication without printing secret material.
5. Check whether sandbox policy blocks required reads, writes, commands, sockets, or network access.
6. Check whether approval policy is causing an impossible prompt in headless mode.
7. Inspect stderr and the JSONL `error` or `turn.failed` events.
8. Re-run with a smaller, deterministic task that reproduces the failure.
9. Do not silently switch to `--yolo` as a troubleshooting shortcut.

## Completion Standard

For implementation tasks, consider the run complete only when Codex has:

1. inspected the relevant repository context,
2. made the requested changes,
3. run the most relevant available validation,
4. reviewed the resulting diff for unrelated changes,
5. reported assumptions and unresolved blockers,
6. produced machine-readable status when requested by the harness.
