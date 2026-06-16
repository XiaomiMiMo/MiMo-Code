---
name: codemap
description: >
  Generate comprehensive hierarchical codemaps for unfamiliar repositories.
  Expensive operation — only use when explicitly asked for codebase documentation
  or initial repository mapping.
  Trigger: "codemap", "map this repo", "codebase documentation", "understand this project".
---

# Codemap Skill

Create hierarchical codemaps to understand and map repositories.

## When to Use

- User asks to understand/map a repository
- User wants codebase documentation
- Starting work on an unfamiliar codebase

## Workflow

### Step 1: Check for Existing State

Check if `.mimocode/codemap.json` exists in repo root.

If it exists: skip to Step 3 (Detect Changes).
If not: continue to Step 2 (Initialize).

### Step 2: Initialize

1. **Analyze repository structure** — list files, understand directories
2. **Infer patterns** for core code/config files ONLY:
   - Include: `src/**/*.ts`, `package.json`, etc.
   - Exclude (MANDATORY): tests, docs, translations
     - Tests: `**/*.test.ts`, `**/*.spec.ts`, `tests/**`, `__tests__/**`
     - Docs: `docs/**`, `*.md` (except root README), `LICENSE`
     - Build/Deps: `node_modules/**`, `dist/**`, `build/**`, `*.min.js`
   - Respect `.gitignore`
3. **Create `.mimocode/codemap.json`** with file/folder structure
4. **Write codemap.md files** — one per relevant subdirectory

Use `glob` to discover files, `read` to understand code, `write` to create codemap files.

### Step 3: Detect Changes (if state exists)

1. Read `.mimocode/codemap.json` for previous state
2. Use `glob` to detect added/removed/modified files
3. Only update affected codemaps
4. Update `.mimocode/codemap.json` with new state

### Step 4: Create Root Codemap (Atlas)

Once all directories mapped, create/update root `codemap.md`:

1. **Map Root Assets** — document root-level files and project purpose
2. **Aggregate Sub-Maps** — extract Responsibility summary from each folder's codemap.md
3. **Cross-Reference** — include paths to sub-maps for navigation

### Step 5: Register in AGENTS.md

Update (or create) `AGENTS.md` at repo root with:

```markdown
## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.
```

This is idempotent — repeated runs detect existing section and skip.

## Codemap Content

Each `codemap.md` should document:

- **Responsibility** — specific role of directory (e.g., "Service Layer", "Data Access Object")
- **Design Patterns** — named patterns used (e.g., "Observer", "Singleton", "Factory")
- **Data & Control Flow** — how data enters/leaves module, function call sequences
- **Integration Points** — dependencies, consumer modules, hooks, events, API endpoints

Example codemap:

```markdown
# src/agents/

## Responsibility
Defines agent personalities and manages their configuration lifecycle.

## Design
Each agent is a prompt + permission set. Config system uses:
- Default prompts (orchestrator.ts, explorer.ts, etc.)
- User overrides from config file
- Permission wildcards for skill/MCP access control

## Flow
1. Plugin loads → calls getAgentConfigs()
2. Reads user config preset
3. Merges defaults with overrides
4. Applies permission rules (wildcard expansion)
5. Returns agent configs

## Integration
- Consumed by: Main plugin (src/index.ts)
- Depends on: Config loader, skills registry
```

Example **Root Codemap (Atlas)**:

```markdown
# Repository Atlas: my-project

## Project Responsibility
A high-performance agent orchestration system.

## System Entry Points
- `src/index.ts`: Plugin initialization
- `package.json`: Dependency manifest

## Directory Map
| Directory | Responsibility | Detail |
|-----------|---------------|--------|
| `src/agents/` | Agent personalities and model routing | [View](src/agents/codemap.md) |
| `src/config/` | Configuration loading pipeline | [View](src/config/codemap.md) |
```
