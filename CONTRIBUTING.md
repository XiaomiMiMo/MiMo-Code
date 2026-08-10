# Contributing to MiMoCode

MiMoCode's codebase moves quickly. Outside contributions are welcome, especially focused improvements to the terminal experience and developer compatibility.

## What we accept

Good contributions include:

- Bug fixes with a clear reproduction
- TUI usability, accessibility, performance, and compatibility improvements
- LSP, formatter, model, and provider compatibility fixes
- Environment-specific quirks (terminal, OS, shell, locale compatibility)
- Documentation fixes and corrections

Please discuss these in an issue before writing code:

- New features, new commands, new configuration surface
- Significant TUI layout, keybinding, or interaction-design changes
- Changes to agent prompts, agent behavior, memory, checkpoints, or tool execution
- Broad refactors, renames, "cleanup", or dependency bumps

These proposals can overlap with ongoing work or require product decisions that are difficult to settle in a pull request. Opening an issue first helps avoid implementing a direction the project cannot adopt.

> [!NOTE]
> If you are unsure whether we would take your change, ask in an issue before writing it.

## When to open an issue

Small bug fixes and documentation corrections can go directly to a pull request. Link an existing issue with `Fixes #123` or `Closes #123` when there is one. For a new feature or a significant design change, open an issue and wait for a maintainer to confirm the direction before implementation.

Good places to start:

- [`bug`](https://github.com/XiaomiMiMo/MiMo-Code/issues?q=is%3Aissue+state%3Aopen+label%3Abug)
- [`help wanted`](https://github.com/XiaomiMiMo/MiMo-Code/issues?q=is%3Aissue+state%3Aopen+label%3A%22help+wanted%22)
- [`good first issue`](https://github.com/XiaomiMiMo/MiMo-Code/issues?q=is%3Aissue+state%3Aopen+label%3A%22good+first+issue%22)

Want to work on an existing issue? Leave a comment first so we can tell you if it is already being worked on.

For security problems, do **not** open an issue. Follow [SECURITY.md](./SECURITY.md).

## Models and providers

Model and provider metadata comes from the upstream [models.dev](https://models.dev) catalog, not from this repository. Adding a provider usually needs no code change here — send the metadata upstream. Any OpenAI-compatible endpoint can also be added at runtime as a custom provider in the TUI, with no PR at all.

## Development

Requirements: Bun 1.3+ (the exact version is pinned by `packageManager` in `package.json`).

```bash
bun ci   # = bun install --frozen-lockfile
bun dev
```

> [!IMPORTANT]
> Use `bun ci`, not `bun install` — we install from `bun.lock` and do not want the lockfile mutated by unrelated changes.

### What is actually maintained

Development is focused on the terminal UI. The web, desktop, and console surfaces inherited from the upstream project are **not maintained**, and PRs against them are not being reviewed.

- `packages/opencode` — core logic, server, and CLI (the directory name is historical)
- `packages/opencode/src/cli/cmd/tui/` — the TUI, written in SolidJS with [opentui](https://github.com/sst/opentui)
- `packages/plugin` — source for `@mimo-ai/plugin`
- `packages/sdk/js` — the generated JavaScript SDK

### Running against another directory

`bun dev` starts in `packages/opencode` by default. To point it elsewhere:

```bash
bun dev <directory>
bun dev .            # run against this repo itself
```

`bun dev` is the local equivalent of the shipped `mimo` command and takes the same arguments:

```bash
bun dev --help
bun dev serve             # headless API server; prints the URL it picked
bun dev serve --port 8080 # pin the port (the default, 0, takes a free one)
```

### Building a local binary

```bash
bun run build:local
./packages/opencode/dist/mimocode-<platform>/bin/mimo
```

Replace `<platform>` with your platform, e.g. `darwin-arm64` or `linux-x64`.

### Checks before you push

```bash
bun typecheck                        # from the repo root
bun lint
bun run --cwd packages/opencode test # tests cannot run from the repo root
./script/format.ts                   # prettier, if your editor does not do it
```

A `pre-push` hook runs `bun typecheck`, so a broken build will not reach the remote.

If you change the server API, regenerate the SDK and OpenAPI schema:

```bash
./script/generate.ts
```

Please follow the [style guide](./AGENTS.md#style-guide).

### Setting up a debugger

Bun debugging is rough around the edges. The most reliable approach is to run MiMoCode manually with `bun run --inspect=<url> dev ...` and attach your debugger to that URL. Other methods can map breakpoints incorrectly, at least in VSCode.

Tips:

- Debug the server and the TUI separately:
  - Server: `bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts serve --port 4096`, then attach the TUI with `mimo attach http://localhost:4096`
  - TUI: `bun run --inspect=ws://localhost:6499/ --cwd packages/opencode --conditions=browser ./src/index.ts`
- `--inspect-wait` / `--inspect-brk` may suit your workflow better than `--inspect`.
- Instead of repeating the flag, `export BUN_OPTIONS=--inspect=ws://localhost:6499/`.

VSCode users can start from [.vscode/launch.example.json](.vscode/launch.example.json), which attaches to the inspector URL above. Avoid `"request": "launch"` configurations and the `JavaScript Debug Terminal`; both tend to misplace breakpoints.

## Pull request expectations

- Keep the PR small and focused on one problem. No unrelated changes.
- Explain the problem and why your change fixes it, in your own words.
- Say **how you verified it**: what you tested, and how a reviewer can reproduce the fix.
- For TUI changes, include a screenshot or recording of before and after.
- Long AI-generated PR descriptions are not acceptable and may be ignored. If you cannot explain the change briefly, it is probably too large.

PR titles follow conventional commits (`fix:`, `docs:`, `chore:`, `test:`, `refactor:`, `feat:`), with an optional package scope:

```
fix: resolve crash on startup
fix(tui): correct cursor position after paste
docs: update contributing guidelines
chore: bump dependency versions
test: cover checkpoint rebuild
```

## Issues

Blank issues are disabled — use one of the templates: **bug report**, **feature request**, or **question**. Fill the required fields with real content; template-shaped placeholder text, walls of generated prose, and issues with no reproduction will be closed.

A feature request is a place to discuss an idea, not a commitment that the project will adopt it. For significant features and design changes, wait for a maintainer to confirm the direction before opening a PR.

## Community

Questions that aren't bugs are best asked in the community group chat — the QR codes are at the bottom of the [README](./README.md#community).
