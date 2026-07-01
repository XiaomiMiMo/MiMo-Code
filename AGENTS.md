- Use MiMoCode Compose skills when available, otherwise use superpowers skill if installed.
- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.
- CI triggers on both `main` and `dev` branches.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Core Focus (as of 2025-06-18)

Our core development focus is the **TUI** (terminal UI) implementation in `packages/opencode/src/cli/cmd/tui/`. We do not currently provide support for Web or App interfaces. All operations should default to checking the TUI implementation first.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## Search & File Lookup Strategy

优先级从高到低：

1. **everything-search MCP** — 找文件路径首选，速度快、全盘索引
2. **Grep** — 搜文件内容用，支持正则
3. **Glob** — 按模式匹配文件名
4. **Read** — 已知路径直接读，不要先 ls 再 Read

### 执行规则

- **先想后做**：收到任务 → 1句话复述 → 确认理解再动手
- **并行调用**：多个独立 glob/grep/read 同一轮发出，不要串行
- **最小调用**：完成简单任务 ≤ 3轮调用，每步问"能不能合并"
- **不重复搜**：同一个地方只搜一次，记住结果
- **不绕路**：用户问"有没有X" → 查记忆 → 没有就直接说，不要翻遍所有配置
