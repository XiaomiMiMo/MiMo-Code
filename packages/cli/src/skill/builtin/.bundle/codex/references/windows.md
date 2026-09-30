# Codex CLI Headless on Windows

## Contents

- Choose native Windows or WSL2
- Install Codex CLI
- Configure the native Windows sandbox
- Run headless tasks from PowerShell
- Capture JSONL and exit status
- Pass prompts and environment variables
- Parse JSONL without `jq`
- Run through WSL2
- Windows-specific troubleshooting

## Choose Native Windows or WSL2

Use native Windows when the repository and build tools are Windows-native, the task needs PowerShell, MSBuild, Visual Studio tooling, Windows paths, or Windows-specific tests.

Use WSL2 when the repository and toolchain are Linux-native, existing automation assumes Bash, or the native Windows sandbox cannot be enabled in the environment.

Do not mix environments during one task unless necessary. In particular:

- Keep a native Windows repository on an NTFS Windows path such as `C:\src\project`.
- Keep a WSL2 repository under the Linux filesystem such as `~/code/project`.
- Avoid running Linux builds repeatedly against `/mnt/c/...`; this is slower and can introduce permission, symlink, file-watcher, and case-sensitivity differences.
- Install and authenticate Codex separately in each environment where it runs.

WSL1 is not supported by current Codex releases. Use WSL2.

## Install Codex CLI

### Native Windows installer

Run from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Verify:

```powershell
codex --version
codex exec --help
```

### npm installation

```powershell
npm install -g @openai/codex
codex --version
```

If `codex` is not found after npm installation, inspect the npm global binary directory and ensure it is on `PATH`:

```powershell
npm prefix -g
Get-Command codex -ErrorAction SilentlyContinue
$env:PATH -split ';'
```

Use PowerShell 7.4 or newer for automation when possible. It preserves native stdout byte streams when redirecting them to files, which is useful for JSONL capture.

## Configure the Native Windows Sandbox

Codex supports native Windows sandbox implementations in `%USERPROFILE%\.codex\config.toml`:

```toml
[windows]
sandbox = "elevated"
```

Prefer `elevated`. It uses dedicated lower-privilege sandbox users, filesystem permission boundaries, firewall rules, and supporting local policy changes.

When administrator-approved setup is unavailable, use the weaker fallback:

```toml
[windows]
sandbox = "unelevated"
```

Do not confuse the Windows sandbox implementation with the task-level CLI policy. Continue to select a task policy such as:

```powershell
--sandbox workspace-write --ask-for-approval never
```

For unattended automation, keep sandbox boundaries enabled and set approval to `never`. Do not switch to full access merely because an approval cannot be answered.

Windows 11 is the recommended baseline. Fully updated Windows 10 is best-effort and requires modern console support; older builds are poor targets for headless runners.

## Run a Basic Headless Task from PowerShell

Use an argument array instead of long lines with PowerShell backtick continuations. Backticks are fragile because trailing whitespace breaks them.

```powershell
$repo = 'C:\src\project'
$prompt = @'
Work fully autonomously.
Do not ask questions or request interactive input.
Inspect the repository, choose conservative defaults, implement the task,
run relevant validation, and report assumptions and blockers.
'@

$codexArgs = @(
    'exec'
    '-C', $repo
    '--sandbox', 'workspace-write'
    '--ask-for-approval', 'never'
    $prompt
)

& codex @codexArgs
if ($LASTEXITCODE -ne 0) {
    throw "Codex failed with exit code $LASTEXITCODE"
}
```

For read-only work, replace `workspace-write` with `read-only` and state explicitly that no files may be changed.

## Production PowerShell Wrapper

```powershell
param(
    [Parameter(Mandatory)]
    [string] $Repository,

    [Parameter(Mandatory)]
    [string] $TaskFile,

    [Parameter(Mandatory)]
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath $Repository).Path
$task = Get-Content -LiteralPath $TaskFile -Raw
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$out = (Resolve-Path -LiteralPath $OutputDirectory).Path

$prompt = @"
Work fully autonomously.
Do not ask questions or request interactive input.
Inspect the repository before making assumptions.
Choose conservative, backward-compatible, non-destructive defaults.
Run relevant validation and report assumptions and blockers.

Task:
$task
"@

$codexArgs = @(
    'exec'
    '-C', $repo
    '--json'
    '--sandbox', 'workspace-write'
    '--ask-for-approval', 'never'
    '--output-last-message', (Join-Path $out 'final.md')
    $prompt
)

$events = Join-Path $out 'events.jsonl'
$stderr = Join-Path $out 'stderr.log'

& codex @codexArgs 1> $events 2> $stderr
$exitCode = $LASTEXITCODE
Set-Content -LiteralPath (Join-Path $out 'exit-code.txt') -Value $exitCode -Encoding ascii

if ($exitCode -ne 0) {
    throw "Codex failed with exit code $exitCode. Inspect $stderr and $events."
}
```

Use `pwsh` 7.4 or newer to run this wrapper when byte-preserving native redirection matters. Always inspect `$LASTEXITCODE`; `$ErrorActionPreference = 'Stop'` alone does not reliably turn every nonzero native exit into a terminating PowerShell error.

## Capture JSONL and the Final Message

```powershell
$out = 'C:\codex-output'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$codexArgs = @(
    'exec'
    '-C', 'C:\src\project'
    '--json'
    '--sandbox', 'workspace-write'
    '--ask-for-approval', 'never'
    '--output-last-message', (Join-Path $out 'final.md')
    'Run tests, fix failures, and report assumptions.'
)

& codex @codexArgs `
    1> (Join-Path $out 'events.jsonl') `
    2> (Join-Path $out 'stderr.log')

$exitCode = $LASTEXITCODE
```

The short redirection example uses backticks only to make the redirection readable. In reusable scripts, prefer a single line or the production wrapper above.

Do not merge stderr into stdout for JSONL output. A command such as `2>&1` can corrupt the JSONL stream with diagnostic text.

## Pass Prompts and Context

Read the entire prompt file as one string:

```powershell
Get-Content -LiteralPath .\prompt.md -Raw | codex exec -
```

Pass a prompt as a positional argument:

```powershell
codex exec 'Analyze this repository. Do not modify files.'
```

Pass command output as additional stdin context:

```powershell
npm test 2>&1 | codex exec 'Analyze this test output and fix the repository.'
```

PowerShell pipelines transport objects and text rather than behaving exactly like Bash byte pipes. For large or encoding-sensitive logs, write the log to a UTF-8 file and include its path in the task, or invoke through WSL2.

## Inject an API Key

For a local shell:

```powershell
$env:CODEX_API_KEY = $env:OPENAI_API_KEY
try {
    codex exec --json 'Triage the repository.'
    if ($LASTEXITCODE -ne 0) {
        throw "Codex failed with exit code $LASTEXITCODE"
    }
}
finally {
    Remove-Item Env:CODEX_API_KEY -ErrorAction SilentlyContinue
}
```

In CI, inject `CODEX_API_KEY` through the runner's secret mechanism and scope it to the Codex step. Remember that repository-controlled subprocesses launched by Codex may inherit the environment. For untrusted repositories, separate credentialed read-only analysis from untrusted build execution.

## Parse JSONL without `jq`

Read all events:

```powershell
$events = Get-Content -LiteralPath .\events.jsonl |
    Where-Object { $_.Trim() } |
    ForEach-Object { $_ | ConvertFrom-Json }
```

Get the session ID:

```powershell
$sessionId = $events |
    Where-Object type -eq 'thread.started' |
    Select-Object -First 1 -ExpandProperty thread_id
```

Get failures:

```powershell
$failures = $events |
    Where-Object { $_.type -in @('turn.failed', 'error') }
```

Get the final agent message emitted as an event:

```powershell
$lastMessage = $events |
    Where-Object {
        $_.type -eq 'item.completed' -and
        $_.item.type -eq 'agent_message'
    } |
    Select-Object -Last 1

$lastMessage.item.text
```

For very large event files, process one line at a time rather than retaining all events in memory.

## Use WSL2

Install WSL from an elevated PowerShell terminal:

```powershell
wsl --install
```

Enter WSL:

```powershell
wsl
```

Inside the WSL shell, install Codex as Linux software:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex --version
```

Keep repositories in the WSL Linux filesystem:

```bash
mkdir -p ~/code
cd ~/code
git clone https://github.com/example/project.git
cd project

codex exec \
  --sandbox workspace-write \
  --ask-for-approval never \
  "Implement the task, run tests, and report blockers."
```

Invoke an already-configured WSL Codex run from PowerShell when needed:

```powershell
$linuxCommand = 'cd ~/code/project && codex exec --sandbox workspace-write --ask-for-approval never "Run the task autonomously."'
wsl.exe -d Ubuntu -- bash -lc $linuxCommand
if ($LASTEXITCODE -ne 0) {
    throw "WSL Codex failed with exit code $LASTEXITCODE"
}
```

For complex orchestration, store the Linux command in a `.sh` script inside WSL and call that script through `wsl.exe`.

Do not pass secrets in a command-line string that can appear in process listings or logs. Configure authentication inside WSL or inject secrets through the WSL job environment.

## Windows-Specific Troubleshooting

### `codex` is not recognized

```powershell
Get-Command codex -ErrorAction SilentlyContinue
npm prefix -g
$env:PATH -split ';'
```

Restart the terminal after installation if `PATH` was changed.

### Installer is blocked

Use the official one-command installer with `-ExecutionPolicy Bypass` for that process. On enterprise-managed machines, script execution, downloaded binaries, local policy changes, or sandbox setup may still be blocked by policy. Do not weaken machine-wide execution policy without administrator approval.

### Native sandbox setup fails

1. Prefer `elevated` on supported machines.
2. Try `unelevated` when administrator-approved setup is unavailable.
3. Use WSL2 when neither native mode works.
4. Do not diagnose the failure by permanently switching to `--yolo`.

### Access denied or unexpected file boundaries

- Confirm `-C` points to the intended repository.
- Inspect Windows ACLs, controlled-folder access, antivirus behavior, and enterprise endpoint policy.
- Avoid repositories under protected or synchronized folders when possible.
- Use `--add-dir` only for a specific required directory, not an entire drive or user profile.

### JSONL is malformed

- Keep stderr separate from stdout.
- Use PowerShell 7.4 or newer for native redirection.
- Do not pipe JSONL through formatting cmdlets.
- Check the file for startup banners, policy warnings, or non-JSON diagnostics.
- Parse line by line and tolerate unknown event types.

### Path quoting fails

Use PowerShell argument arrays and literal paths. Do not manually add embedded quote characters around array elements:

```powershell
$codexArgs = @('exec', '-C', 'C:\src\project with spaces', 'Analyze the project.')
& codex @codexArgs
```

### A child command waits for input

The Codex prompt policy prevents Codex from asking the user, but project tools may still prompt. Configure those tools explicitly, for example with package-manager non-interactive flags, environment variables, or command-specific confirmation options. Do not implement a generic "press Enter" or "select the first option" mechanism.

## Official References

- Codex CLI: `https://learn.chatgpt.com/docs/codex/cli`
- Codex non-interactive mode: `https://learn.chatgpt.com/docs/non-interactive-mode`
- Native Windows sandbox: `https://learn.chatgpt.com/docs/windows/windows-sandbox`
- WSL guidance: `https://learn.chatgpt.com/docs/windows/wsl`
