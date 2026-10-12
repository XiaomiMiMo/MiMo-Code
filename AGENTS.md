# MiMo-Code

## Conventions

- Use MiMoCode Compose skills when available, otherwise use superpowers skill if installed.
- To regenerate the JavaScript SDK, run `./packages/sdk/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.
- CI triggers on `main`.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.
- Install deps with `bun ci` (= `bun install --frozen-lockfile`) — install per `bun.lock`, don't mutate the lockfile. ⛔ Do NOT use `bun install`/`npm install`.
- Comments, docs, shipped skill content and test assertions use synthetic values, never machine-specific ones — `/tmp/example` for paths, `test/model` for model refs, `feat/example` for branches.
- Do not edit `packages/cli/migration/*/migration.sql` that already shipped — engines have applied those journals; new schema changes get a **new** migration directory under `packages/cli/migration/`.

## Style Guide

Match the style of the surrounding code. The rules below apply across the repository.

### Types and errors

- Avoid using the `any` type
- Inside Effect code, express failures through the Effect error channel (`Effect.try`, `Effect.tryPromise`, `Effect.catchTag`, typed errors) rather than `try`/`catch`; plain scripts and non-Effect code may use `try`/`catch`

### Bun and Node runtimes

- Use Bun APIs where the runtime is Bun-only, like `Bun.file()` in the TUI (`src/cli/cmd/tui/`); build-time macros are fine anywhere, as they never reach the shipped runtime
- In core code reachable from `src/node.ts`, prefer the Node equivalent when one exists — `createHash` over `Bun.CryptoHasher`, `prepare()` over bun:sqlite's `query()` — as that code also ships through `script/build-node.ts` and must run on plain Node
- Bun-only calls in core escape both `typecheck` and `bun test`, which run on Bun; existing usage needs no urgent removal, and APIs with no Node equivalent may stay until a runtime seam exists

### Config modules

In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

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
