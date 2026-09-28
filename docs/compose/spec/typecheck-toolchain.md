---
feature: typecheck-toolchain
status: delivered
updated: 2026-09-28
branch: typecheck/ts7-drop-turbo
commits: 
---

# Typecheck Toolchain: Drop Turbo, TypeScript 7, Scripts Project

## Report

**What was built** — Dropped turbo in favor of `bun run --workspaces --if-present --parallel` plus a root `tsconfig.scripts.json` project for tooling scripts. Migrated typecheck/emit to TypeScript 7 (`@typescript/native` → `tsc` 7.0.2) while keeping the JS Compiler API on `typescript@6.0.2` for `tool-script.ts`. Folded `packages/script` into `script/meta.ts` with relative imports; deleted the workspace package. Added thin `script/tsconfig.json` wrappers so IDEs resolve the shared scripts project, set `types: ["bun"]` where `@types/bun` is needed, and stopped the root `tsconfig.json` from claiming every `.ts` file (solution-style `files: []` + references). Effect language-service diagnostics that only `tsc` (not `tsgo`) reports were triaged: two real `floatingEffect` bugs fixed; remaining plugin noise does not gate CI.

**Verification** — `bun typecheck` PASS (workspaces + scripts project); `tsc --noEmit -p tsconfig.scripts.json` PASS; per-package `bun run typecheck` PASS on opencode/plugin/shared/sdk/js with `tsc --version` = 7.0.2; `require("typescript").transpileModule` is a function (6.0.2); `packages/plugin` `bun run build` (tsc emit) PASS; `packages/shared` `bun test` 55 pass / 0 fail; `script/meta.ts` runtime smoke PASS. Independent review caught package-local `tsc` resolving to TS 6 via workspace bin shadowing — fixed by declaring `@typescript/native` on every package that runs `tsc`. JSON reformat drift (`keywords` arrays) restored to repo style.

**Journey log** — 1) bun 1.3.14 nested `npm:` aliases break `@typescript/typescript6` (empty JS API); use real `typescript@6` + `@typescript/native@7` instead. 2) `tsgo` never loaded `@effect/language-service` (patch targets the JS compiler); silence was a blind spot. 3) Workspace packages pin `tsc` to their own `typescript` dep — root `@typescript/native` does not win `bun run` PATH. 4) `JSON.stringify`/`json.dumps` rewrite of package.json/tsconfig produces noisy diffs — edit in place. 5) Root tsconfig with default include fights nested script tsconfigs in VS Code; make it a `files: []` solution stub.

## [S1] Problem

1. **turbo is a single-task leftover.** After #2573 removed web/desktop/cloud packages, turbo only runs `typecheck` across 4 packages (`opencode`, `plugin`, `shared`, `sdk/js`). `turbo.json` declares an empty `typecheck` task (no cache inputs/outputs/dependsOn); the local cache is 64K/16 entries. Parallelism can be done by Bun itself. Dead-code-cleanup already recorded this as a follow-up.

2. **typecheck compiler is a stale preview.** Scripts run `tsgo --noEmit` from `@typescript/native-preview@7.0.0-dev.20251207.1` (2025-12 nightly). TypeScript 7.0.2 is GA on npm as `typescript` with binary `tsc` (native Go port). The repo still pins `typescript@5.8.2` for the JS Compiler API (`tool-script.ts` uses `transpileModule`).

3. **`packages/script` is not a real package.** It is a 1-file metadata helper (`Script.channel/version/preview/release`) consumed only by release/build/publish tooling. It should live under `script/`, not as `@mimo-ai/script` workspace package.

4. **Script paths are missing from typecheck and the editor.** `plugin`/`sdk/js` `include: ["src"]` skips `script/`. `packages/script` has no `typecheck` script. Root `script/` is not in any typecheck project. Opening these files shows red `Bun` / `process` because the nearest tsconfig either omits bun types (`types: []` on opencode) or never claims the file (plugin/sdk `include: src`).

## [S2] Design

### D1. Remove turbo; typecheck via Bun workspaces

- Delete `turbo` devDependency, `turbo.json`, and the root `typecheck` → `bun turbo typecheck` indirection.
- Root script becomes:

```json
"typecheck": "bun run --workspaces --if-present --parallel typecheck && tsc --noEmit -p tsconfig.scripts.json"
```

**Bun 1.3.14 contracts (verified):**
- `bun run --workspaces <script>` runs in workspace packages only (not root) and **errors** if any package lacks the script.
- `--if-present` skips packages without the script (`@mimo-ai/script` has none today).
- `--filter` only matches packages that **have** the script (so `--filter '*'` is also safe).
- `--parallel` gives Foreman-style output and is fine for independent package typechecks.
- Do **not** use `bun install` (lockfile mutation); keep `bun ci`.

### D2. TypeScript 7 for typecheck + emit; JS API stays on `typescript@6`

**Cannot** use the official side-by-side alias layout under Bun 1.3.14:

```json
// BROKEN on bun 1.3.14 — nested npm: alias resolves @typescript/old to the shim itself
"typescript": "npm:@typescript/typescript6@^6.0.2"
```

`require("typescript").transpileModule` is `undefined` (circular `@typescript/old` → `@typescript/typescript6`).

**Verified working layout:**

| Role | Package | Binary / import |
|------|---------|-----------------|
| JS API (`import ts from "typescript"`) | `typescript@6.0.2` (real) | `require("typescript")` → `transpileModule`, `createSourceFile` |
| typecheck + emit (`tsc`) | `@typescript/native` = `npm:typescript@7.0.2` | `node_modules/.bin/tsc` → Version 7.0.2 |
| optional TS6 CLI | `node_modules/typescript/bin/tsc` | Version 6.0.2 |

Catalog / deps:
- Remove `@typescript/native-preview` everywhere (catalog + package devDeps).
- Set catalog `typescript` to `6.0.2` (JS API + plugin/sdk `build: tsc` currently resolve `typescript`).
- Add root (and any package that needs `tsc` on its PATH via workspace hoist) `@typescript/native: npm:typescript@7.0.2`.
- Package `typecheck` scripts: `tsgo --noEmit` → `tsc --noEmit`.
- plugin/sdk `build` keep `tsc` / `bun tsc` — now TS7 emit (user decision). `tsc --declaration --noEmit` smoke must pass on plugin/sdk.

**Do not** change `tool-script.ts` / test AST usage; they keep `import ts from "typescript"` against the 6.x JS API.

**Industry pattern for "TS7 has no JS API" (researched 2026-09-28):**
- Official / Nx / Next.js recommended side-by-side is
  `{ "typescript": "npm:@typescript/typescript6@^6", "@typescript/native": "npm:typescript@^7" }`.
- `@typescript/typescript6` is a **thin shim** (`lib/typescript.js` → `require("@typescript/old")`). Known breakages:
  subpath `typescript/lib/tsserverlibrary` (typescript-eslint project-service), Yarn compat patch
  `ENOENT lib/_tsc.js`, and on **bun 1.3.14** nested `npm:` aliases resolve `@typescript/old` back to the
  shim (empty API). Yarn also mis-links `tsc` to TS6 (`yarnpkg/berry#7215`).
- Therefore this repo installs **real** `typescript@6.0.2` under the `typescript` name (full JS API + `tsc6`
  CLI at `node_modules/typescript/bin/tsc`) and TS7 only as `@typescript/native` (`bin.tsc` wins
  `node_modules/.bin/tsc` → 7.0.2). Verified: `require("typescript").transpileModule` works; `tsc -V` is 7.0.2.
- Programmatic API is expected back in TS **7.1**; until then tools that `require("typescript")` must keep a
  6.x package under that name.

**Why `tsgo` was quiet and `tsc` is noisy (`@effect/language-service`):**
- The plugin is declared in opencode/shared `tsconfig.plugins`. Its `prepare` hook
  (`effect-language-service patch`) rewrites the **JS** `typescript` package (`lib/_tsc.js`) so CLI `tsc`
  runs language-service diagnostics.
- `tsgo` (`@typescript/native-preview`) is a **separate native binary** that never loads that patched JS
  compiler, so Effect rules never executed — silence was a blind spot, not proof of cleanliness.
- Same reason `tsc` now surfaces `floatingEffect` / `missingReturnYieldStar` / etc.
Mitigations: fix 2 real `floatingEffect` (`yield* elog.info` in `prompt.ts`), keep `missingReturnYieldStar`
as warning, set `ignoreEffect{Errors,Warnings,Suggestions}InTscExitCode: true` so plugin chatter stays in
the editor and does not gate CI. Also `types: ["bun"]` is required (tsgo auto-included `@types/bun`; tsc does not).

**Bun workspace `tsc` bin shadowing (review CRITICAL):** a package that depends on `typescript` gets
`packages/<pkg>/node_modules/.bin/tsc → ../typescript/bin/tsc` (the 6.x CLI), which `bun run` puts first on
PATH. Root `@typescript/native` alone is not enough. Every package that runs `tsc` therefore declares
`@typescript/native: npm:typescript@7.0.2` so its local `.bin/tsc` is the native 7.x binary. `typescript@6`
stays only where the JS API is imported (`import ts from "typescript"` in `tool-script.ts`); plugin/sdk drop
the `typescript` dep entirely (they only need the compiler CLI). Verified: all four packages report
`tsc --version` = 7.0.2 while `require("typescript").transpileModule` remains a function on 6.0.2.

### D3. Fold `packages/script` into root `script/meta.ts`

**The module is live release tooling** (not dead). Call sites:

| File | Symbols used |
|------|----------------|
| `script/release.ts` | `version`, `channel`, `release` |
| `script/version.ts` | `version`, `preview`, `channel` |
| `script/publish.ts` | `version` |
| `script/sync-registry.ts` | `version`, `channel` |
| `packages/opencode/script/build.ts` | `version`, `channel`, `release` |
| `packages/opencode/script/build-node.ts` | `version`, `channel` |
| `packages/opencode/script/publish.ts` | `channel` |
| `packages/plugin/script/publish.ts` | `channel` |
| `packages/sdk/js/script/publish.ts` | `channel` |

Not imported from runtime `src/` / `test/`. Build/release only.

- Move `packages/script/src/index.ts` → `script/meta.ts` (export `Script`).
- Drop the module-load `console.log` (debug leftover; every importer currently prints on import).
- Path fixes after the move (`import.meta.dir` is now `script/`):
  - root package.json → `../package.json`
  - opencode package.json → `../packages/opencode/package.json`
- Replace `import { Script } from "@mimo-ai/script"` with relative imports:
  - `script/*.ts` → `./meta.ts`
  - `packages/*/script/*.ts` and `packages/sdk/js/script/*.ts` → `../../../script/meta.ts` / `../../../../script/meta.ts`
- Delete `packages/script/` workspace package.
- Remove `@mimo-ai/script` from root `dependencies` and `packages/opencode` `dependencies`/`devDependencies`.
- `semver` stays available from root `devDependencies`.

### D4. One scripts typecheck project + editor configs

**Shared project** `tsconfig.scripts.json` (repo root) is the single typecheck target for all tooling scripts:

- `extends`: `@tsconfig/bun/tsconfig.json`
- `compilerOptions.types`: `["bun"]` (fixes red `Bun` / `process`)
- `compilerOptions.noUncheckedIndexedAccess`: `false` (match opencode/shared)
- `include`:
  - `script/**/*.ts`
  - `packages/opencode/script/**/*.ts`
  - `packages/plugin/script/**/*.ts`
  - `packages/sdk/js/script/**/*.ts`
- `exclude`:
  - `packages/opencode/script/generate.ts`
  - `packages/opencode/script/schema.ts`

Those two import `../src/**` with `@/` paths. Pulling app sources into the scripts project reintroduces ~600 unrelated app diagnostics under a second config. They **stay in `packages/opencode` typecheck** (already in that project's program and currently clean). Editor continues to use `packages/opencode/tsconfig.json` for them.

**Editor (nearest `tsconfig.json`):** TypeScript only auto-picks files named `tsconfig.json`. Thin wrappers so IDEs resolve the shared project:

| Path | Content |
|------|---------|
| `script/tsconfig.json` | `{ "extends": "../tsconfig.scripts.json", "include": ["./**/*.ts"] }` |
| `packages/plugin/script/tsconfig.json` | `{ "extends": "../../tsconfig.scripts.json", "include": ["./**/*.ts"] }` |
| `packages/sdk/js/script/tsconfig.json` | `{ "extends": "../../../tsconfig.scripts.json", "include": ["./**/*.ts"] }` |

No wrapper under `packages/opencode/script/` — nearest config must remain `packages/opencode/tsconfig.json` so `generate.ts` / `schema.ts` keep `@/` paths.

**opencode editor fix:** change `"types": []` → `"types": ["bun"]` in `packages/opencode/tsconfig.json` (verified: full `tsgo --noEmit` still passes). That clears red `Bun`/`process` for `packages/opencode/script/*` and any Bun usage under the app project.

**Script type errors to fix** (found when scripts are actually checked; currently hidden):
- `packages/opencode/script/publish.ts:31` — `Object is possibly 'undefined'`
- `packages/sdk/js/script/publish.ts` — implicit `any` return on `transformExports`, `Record` mismatch

### D5. Docs / hooks

- `README.md` / `README.zh.md`: `bun turbo typecheck` → `bun typecheck`.
- `CONTRIBUTING.md` unchanged (`bun typecheck` already).
- pre-push hook already calls `bun typecheck` — unchanged.
- `dead-code-cleanup.md` historical note left as-is (it recorded turbo as intentional leftover).

## [S3] Out of Scope

- No change to `tool-script.ts` JS-API call sites beyond the compiler package identity.
- No migrate of `oxlint-tsgolint` / oxlint type-aware rules.
- No upgrade of `@tsconfig/bun` / `@tsconfig/node22`.
- No rewrite of release/publish scripts' behavior (only import paths and the Script module location).
- No project-references / composite restructure of opencode.
- `packages/opencode/script/generate.ts` / `schema.ts` remain app-adjacent; not moved.

## Tasks

- [x] T1: Remove turbo and switch root typecheck to `bun run --workspaces --if-present --parallel` — acceptance: `turbo` gone from package.json/lockfile, `bun typecheck` invokes workspace typechecks in parallel, no `turbo.json` (covers: S2-D1)
- [x] T2: Migrate compiler packages to `typescript@6` + `@typescript/native@7`, drop `@typescript/native-preview`, rename `tsgo` scripts to `tsc` — acceptance: `node_modules/.bin/tsc --version` is 7.x, `require("typescript").transpileModule` is a function, every package `typecheck` is `tsc --noEmit` and passes (covers: S2-D2; depends: T1)
- [x] T3: Move `packages/script` to `script/meta.ts`, retarget all `@mimo-ai/script` imports, delete the workspace package — acceptance: no `@mimo-ai/script` references, `script/meta.ts` exports `Script`, release/build scripts still resolve version/channel/preview/release (covers: S2-D3)
- [x] T4: Add `tsconfig.scripts.json` + thin editor tsconfigs, set opencode `types: ["bun"]`, fix script type errors, wire scripts typecheck into root `typecheck` — acceptance: `tsc --noEmit -p tsconfig.scripts.json` passes, root `bun typecheck` includes scripts project, editor configs cover `script/`, `plugin/script`, `sdk/js/script`, opencode script files no longer red on `Bun`/`process` (covers: S2-D4; depends: T3)
- [x] T5: Update README typecheck commands and verify end-to-end — acceptance: docs say `bun typecheck`, full root typecheck green, plugin/sdk `tsc` emit still works (covers: S2-D5; depends: T2, T4)
