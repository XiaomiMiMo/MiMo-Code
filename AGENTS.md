# MiMo-Code

## Conventions

- Use MiMoCode Compose skills when available, otherwise use superpowers skill if installed.
- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.
- CI triggers on `main`.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.
- Install deps with `bun ci` (= `bun install --frozen-lockfile`) — install per `bun.lock`, don't mutate the lockfile. ⛔ Do NOT use `bun install`/`npm install`.

## Core Focus

Development focuses on the **TUI** (`packages/opencode/src/cli/cmd/tui/`) and the **engine core** it runs on. The Web, App and Desktop surfaces are not currently maintained. In practice this means an operation should default to checking the TUI path first.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs where the runtime is Bun-only, like `Bun.file()` in the TUI (`src/cli/cmd/tui/`); build-time macros are fine anywhere, as they never reach the shipped runtime
- In core code reachable from `src/node.ts`, prefer the Node equivalent when one exists — `createHash` over `Bun.CryptoHasher`, `prepare()` over bun:sqlite's `query()` — as that code also ships through `script/build-node.ts` and must run on plain Node
- Bun-only calls in core escape both `typecheck` and `bun test`, which run on Bun; existing usage needs no urgent removal, and APIs with no Node equivalent may stay until a runtime seam exists
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

### Reading a nullable column

Two independent absences meet in one expression, and only one of them is
`undefined`. `.get()` yields `undefined` when no row matches — Drizzle normalises
the driver's `null` there — while a nullable column's SQL `NULL` arrives as
`null`. So `row?.some_column` is `T | null | undefined`.

When a caller only asks "is there a value", flatten to `undefined`, and write the
flattening as an annotation rather than an `as` cast:

```ts
// Good — the compiler enforces it; deleting the `?? undefined` is a type error
const boundary: MessageID | undefined = row?.last_checkpoint_message_id ?? undefined

// Bad — the cast removes `null` from the union without converting anything,
// so the declared type is untrue at runtime
return row?.last_checkpoint_message_id as MessageID | undefined
```

Discriminate a possibly-absent value with truthiness or `== null`, never with
`=== undefined` / `!== undefined`. Because `null !== undefined` is `true`, such a
guard typechecks, reads correctly in review, and does nothing.

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.
