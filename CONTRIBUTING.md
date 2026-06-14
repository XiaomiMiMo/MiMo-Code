# Contributing to Devora

Devora aims to make contribution work straightforward. The most common types of changes that get merged are:

- Bug fixes
- Additional LSPs / Formatters
- Improvements to LLM performance
- Support for new providers
- Fixes for environment-specific quirks
- Missing standard behavior
- Documentation improvements

However, any UI or core product feature should go through a design review with Sheri Akhtamov or a project maintainer before implementation.

If you are unsure if a PR would be accepted, ask in an issue or look for issues with any of the following labels:

- [`help wanted`](https://github.com/SheriAkhtamov/Devora/issues?q=is%3Aissue%20state%3Aopen%20label%3Ahelp-wanted)
- [`good first issue`](https://github.com/SheriAkhtamov/Devora/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22)
- [`bug`](https://github.com/SheriAkhtamov/Devora/issues?q=is%3Aissue%20state%3Aopen%20label%3Abug)
- [`perf`](https://github.com/SheriAkhtamov/Devora/issues?q=is%3Aopen%20is%3Aissue%20label%3A%22perf%22)

> [!NOTE]
> PRs that ignore these guardrails will likely be closed.

Want to take on an issue? Leave a comment and a maintainer may assign it to you unless it is already in progress.

## Adding New Providers

New providers shouldn't require many if ANY code changes, but if you want to add support for a new provider first make a PR to:
https://models.dev

## Developing Devora

- Requirements: Bun 1.3+
- Install dependencies and start the dev server from the repo root:

  ```bash
  bun install
  bun dev
  ```

### Running against a different directory

By default, `bun dev` runs Devora in the `packages/devora` directory. To run it against a different directory or repository:

```bash
bun dev <directory>
```

To run Devora in the root of the devora repo itself:

```bash
bun dev .
```

### Building a local CLI

To compile a standalone executable:

```bash
./packages/devora/script/build.ts --single
```

Then run it with:

```bash
./packages/devora/dist/devora-<platform>/bin/devora
```

Replace `<platform>` with your platform (e.g., `darwin-arm64`, `linux-x64`).

- Core pieces:
  - `packages/devora`: Devora core business logic & server.
  - `packages/devora/src/cli/cmd/tui/`: The TUI code, written in SolidJS with [opentui](https://github.com/sst/opentui)
  - `packages/app`: The shared web UI components, written in SolidJS
  - `packages/desktop`: The native desktop app, built with Electron (wraps `packages/app`)
  - `packages/plugin`: Source for `@devora-ai/plugin`

### Understanding bun dev vs devora

During development, `bun dev` is the local equivalent of the built `devora` command. Both run the same CLI interface:

```bash
# Development (from project root)
bun dev --help           # Show all available commands
bun dev serve            # Start headless API server
bun dev web              # Start server + open web interface
bun dev <directory>      # Start TUI in specific directory

# Production
devora --help          # Show all available commands
devora serve           # Start headless API server
devora web             # Start server + open web interface
devora <directory>     # Start TUI in specific directory
```

### Running the API Server

To start the Devora headless API server:

```bash
bun dev serve
```

This starts the headless server on port 4096 by default. You can specify a different port:

```bash
bun dev serve --port 8080
```

### Running the Web App

To test UI changes during development:

1. **First, start the Devora server** (see [Running the API Server](#running-the-api-server) section above)
2. **Then run the web app:**

```bash
bun run --cwd packages/app dev
```

This starts a local dev server at http://localhost:5173 (or similar port shown in output). Most UI changes can be tested here, but the server must be running for full functionality.

### Running the Desktop App

The desktop app is a native Electron application that wraps the web UI.

To run the native desktop app:

```bash
bun run dev:desktop
```

This starts the Electron development app and opens the native window.

If you only want the web dev server (no native shell):

```bash
bun run --cwd packages/desktop dev
```

To create a production `dist/` and build the native macOS app bundle:

```bash
bun run --cwd packages/desktop build
bun run --cwd packages/desktop package:mac -- --arm64 --publish never
```

The first command builds the renderer and Electron entrypoints. The second command packages the macOS app locally without publishing a release.

> [!NOTE]
> Publishing desktop updates is handled by the GitHub Actions release workflow in this repository. Local desktop packaging is mainly for verification.

> [!NOTE]
> If you make changes to the API or SDK (e.g. `packages/devora/src/server/server.ts`), run `./packages/sdk/js/script/build.ts` to regenerate the JavaScript SDK and related files.

Please try to follow the [style guide](./AGENTS.md)

### Setting up a Debugger

Bun debugging is currently rough around the edges. We hope this guide helps you get set up and avoid some pain points.

The most reliable way to debug Devora is to run it manually in a terminal via `bun run --inspect=<url> dev ...` and attach
your debugger via that URL. Other methods can result in breakpoints being mapped incorrectly, at least in VSCode (YMMV).

Caveats:

- If you want to run the Devora TUI and have breakpoints triggered in the server code, you might need to run `bun dev spawn` instead of
  the usual `bun dev`. This is because `bun dev` runs the server in a worker thread and breakpoints might not work there.
- If `spawn` does not work for you, you can debug the server separately:
  - Debug server: `bun run --inspect=ws://localhost:6499/ --cwd packages/devora ./src/index.ts serve --port 4096`,
    then attach TUI with `devora attach http://localhost:4096`
  - Debug TUI: `bun run --inspect=ws://localhost:6499/ --cwd packages/devora --conditions=browser ./src/index.ts`

Other tips and tricks:

- You might want to use `--inspect-wait` or `--inspect-brk` instead of `--inspect`, depending on your workflow
- Specifying `--inspect=ws://localhost:6499/` on every invocation can be tiresome, you may want to `export BUN_OPTIONS=--inspect=ws://localhost:6499/` instead

#### VSCode Setup

If you use VSCode, you can use the example configurations [.vscode/settings.example.json](.vscode/settings.example.json) and [.vscode/launch.example.json](.vscode/launch.example.json).

Some debug methods that can be problematic:

- Debug configurations with `"request": "launch"` can have breakpoints incorrectly mapped and thus unusable
- The same problem arises when running Devora in the VSCode `JavaScript Debug Terminal`

With that said, you may want to try these methods, as they might work for you.

## Pull Request Expectations

### Issue First Policy

**All PRs must reference an existing issue.** Before opening a PR, open an issue describing the bug or feature. This helps maintainers triage and prevents duplicate work. PRs without a linked issue may be closed without review.

- Use `Fixes #123` or `Closes #123` in your PR description to link the issue
- For small fixes, a brief issue is fine - just enough context for maintainers to understand the problem

### General Requirements

- Keep pull requests small and focused
- Explain the issue and why your change fixes it
- Before adding new functionality, ensure it doesn't already exist elsewhere in the codebase

### UI Changes

If your PR includes UI changes, please include screenshots or videos showing the before and after. This helps maintainers review faster and gives you quicker feedback.

### Logic Changes

For non-UI changes (bug fixes, new features, refactors), explain **how you verified it works**:

- What did you test?
- How can a reviewer reproduce/confirm the fix?

### No AI-Generated Walls of Text

Long, AI-generated PR descriptions and issues are not acceptable and may be ignored. Respect the maintainers' time:

- Write short, focused descriptions
- Explain what changed and why in your own words
- If you can't explain it briefly, your PR might be too large

### PR Titles

PR titles should follow conventional commit standards:

- `feat:` new feature or functionality
- `fix:` bug fix
- `docs:` documentation or README changes
- `chore:` maintenance tasks, dependency updates, etc.
- `refactor:` code refactoring without changing behavior
- `test:` adding or updating tests

You can optionally include a scope to indicate which package is affected:

- `feat(app):` feature in the app package
- `fix(desktop):` bug fix in the desktop package
- `chore(devora):` maintenance in the devora package

Examples:

- `docs: update contributing guidelines`
- `fix: resolve crash on startup`
- `feat: add dark mode support`
- `feat(app): add dark mode support`
- `fix(desktop): resolve crash on startup`
- `chore: bump dependency versions`

### Style Preferences

These are not strictly enforced, they are just general guidelines:

- **Functions:** Keep logic within a single function unless breaking it out adds clear reuse or composition benefits.
- **Destructuring:** Do not do unnecessary destructuring of variables.
- **Control flow:** Avoid `else` statements.
- **Error handling:** Prefer `.catch(...)` instead of `try`/`catch` when possible.
- **Types:** Reach for precise types and avoid `any`.
- **Variables:** Stick to immutable patterns and avoid `let`.
- **Naming:** Choose concise single-word identifiers when they remain descriptive.
- **Runtime APIs:** Use Bun helpers such as `Bun.file()` when they fit the use case.

## Feature Requests

For net-new functionality, start with a design conversation. Open an issue describing the problem, your proposed approach (optional), and why it belongs in Devora. Sheri Akhtamov or a project maintainer will help decide whether it should move forward; please wait for that approval instead of opening a feature PR directly.

## Trust & Vouch System

This project uses [vouch](https://github.com/mitchellh/vouch) to manage contributor trust. The vouch list is maintained in [`.github/VOUCHED.td`](.github/VOUCHED.td).

### How it works

- **Vouched users** are explicitly trusted contributors.
- **Denounced users** are explicitly blocked. Issues and pull requests from denounced users are automatically closed. If you have been denounced, you can request to be unvouched by opening a respectful follow-up issue for a maintainer to review.
- **Everyone else** can participate normally — you don't need to be vouched to open issues or PRs.

### For maintainers

Collaborators with write access can manage the vouch list by commenting on any issue:

- `vouch` — vouch for the issue author
- `vouch @username` — vouch for a specific user
- `denounce` — denounce the issue author
- `denounce @username` — denounce a specific user
- `denounce @username <reason>` — denounce with a reason
- `unvouch` / `unvouch @username` — remove someone from the list

Changes are committed automatically to `.github/VOUCHED.td`.

### Denouncement policy

Denouncement is reserved for users who repeatedly submit low-quality AI-generated contributions, spam, or otherwise act in bad faith. It is not used for disagreements or honest mistakes.

## Issue Requirements

All issues **must** use one of the Devora issue templates:

- **Bug report** — for reporting bugs (requires a description)
- **Feature request** — for suggesting enhancements (requires verification checkbox and description)
- **Question** — for asking questions (requires the question)

Blank issues are not allowed. When a new issue is opened, an automated check verifies that it follows a template and meets our contributing guidelines. If an issue doesn't meet the requirements, you'll receive a comment explaining what needs to be fixed and have **2 hours** to edit the issue. After that, it will be automatically closed.

Issues may be flagged for:

- Not using a template
- Required fields left empty or filled with placeholder text
- AI-generated walls of text
- Missing meaningful content

If you believe your issue was incorrectly flagged, let a maintainer know.
