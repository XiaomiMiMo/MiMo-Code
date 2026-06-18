# @mimo-ai/cli

The core package of MiMoCode — a terminal-native AI coding assistant. This package contains the CLI, TUI, session engine, provider system, tool system, plugin framework, and HTTP server.

## Prerequisites

- [Bun](https://bun.sh) 1.3+

## Development

```bash
# From the repository root
bun install
bun dev                # Run TUI in packages/opencode
bun dev <directory>    # Run TUI in a specific directory
bun dev .              # Run TUI in the repository root
```

### CLI Commands

```bash
bun dev --help              # Show all available commands
bun dev serve               # Start headless API server (default port 4096)
bun dev serve --port 8080   # Start server on a custom port
bun dev web                 # Start server + open web interface
bun dev models              # List available models
bun dev providers           # List available providers
```

### Type Checking & Linting

```bash
bun typecheck               # Run TypeScript type checker (tsgo)
bun run lint                # Run oxlint from repository root
```

### Testing

Tests must be run from within this package directory, not the repository root.

```bash
bun test                    # Run all tests
bun test --timeout 30000    # Run with extended timeout
```

Test infrastructure lives in `test/`:

- `test/fixture/` — temp directory factories and Effect-based test helpers
- `test/lib/llm-server.ts` — mock LLM server (OpenAI-compatible SSE)
- `test/lib/mock-llm.ts` — lightweight in-process LLM mock
- `test/preload.ts` — test environment bootstrap (isolated DB, env vars, XDG dirs)

### Building

```bash
# Build a standalone executable
./script/build.ts --single

# Output location
./dist/opencode-<platform>/bin/opencode
```

## Architecture

```
src/
├── cli/              # CLI entry point (yargs) and commands
│   └── cmd/tui/      # TUI application (SolidJS + OpenTUI)
├── session/          # Session engine: LLM streaming, prompts, checkpoints
├── provider/         # LLM provider abstraction (20+ SDKs)
├── tool/             # Agent tools (bash, edit, read, write, grep, glob, etc.)
├── agent/            # Agent definitions and configuration
├── actor/            # Sub-agent spawning and lifecycle
├── plugin/           # Plugin framework (internal + external + file hooks)
├── server/           # HTTP/WebSocket server (Hono)
├── config/           # Configuration system (24 modules)
├── storage/          # SQLite storage (Drizzle ORM)
├── memory/           # Persistent memory (FTS5 full-text search)
├── task/             # Tree-shaped task tracking
├── workflow/         # Workflow engine (inline JS orchestration)
├── effect/           # Effect-TS runtime and DI infrastructure
├── bus/              # Event bus (pub/sub)
├── mcp/              # Model Context Protocol client
├── lsp/              # Language Server Protocol client
├── permission/       # Tool execution permissions
├── format/           # Code formatter integration
├── file/             # Filesystem utilities (ignore, watcher, ripgrep)
├── util/             # Shared utilities (30+ modules)
└── index.ts          # Main CLI entry point
```

### Key Dependencies

| Dependency | Purpose |
|-----------|---------|
| [Effect-TS](https://effect.website) | DI, error handling, concurrency |
| [SolidJS](https://www.solidjs.com) | TUI component framework |
| [OpenTUI](https://github.com/sst/opentui) | Terminal UI primitives |
| [Hono](https://hono.dev) | HTTP server |
| [Drizzle ORM](https://orm.drizzle.team) | SQLite storage |
| [AI SDK](https://sdk.vercel.ai) | LLM provider abstraction |
| [Tree-sitter](https://tree-sitter.github.io) | Shell parsing |

## Configuration

Configuration is loaded from `.mimocode/mimocode.json` in the project directory or `~/.config/mimocode/mimocode.json` globally. See the main [MiMoCode README](../../README.md) for available options.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines. All PRs must reference an existing issue.

## License

MIT — see [LICENSE](../../LICENSE).
