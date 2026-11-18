import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Database } from "../../src/storage"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { MemoryFtsTable } from "../../src/memory/fts.sql"
import { Memory } from "../../src/memory"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  Database.use((db) => db.delete(MemoryFtsTable).run())
  await Instance.disposeAll()
  delete process.env.MIMOCODE_SEMANTIC_ENABLED
  delete process.env.MIMOCODE_SEMANTIC_MEMORY
  delete process.env.MIMOCODE_SEMINDEX_HELPER
  delete process.env.MIMOCODE_TEST_MARKER
  delete process.env.MIMOCODE_TEST_DELETE_SOURCE
  delete process.env.MIMOCODE_TEST_DUPLICATE_SOURCE
  delete process.env.MIMOCODE_TEST_BEST_SOURCE
})

const it = testEffect(Layer.mergeAll(Memory.defaultLayer, CrossSpawnSpawner.defaultLayer))
const helper = `import hashlib, json, os, sys
request = json.load(sys.stdin)
marker = os.environ.get("MIMOCODE_TEST_MARKER")
if marker:
    open(marker, "w").write("called")
delete_source = os.environ.get("MIMOCODE_TEST_DELETE_SOURCE")
if delete_source:
    os.unlink(delete_source)
duplicate_source = os.environ.get("MIMOCODE_TEST_DUPLICATE_SOURCE")
best_source = os.environ.get("MIMOCODE_TEST_BEST_SOURCE")
text = "semantic-only phrase"
hits = []
for source in request["allowed"]:
    rank = 1 if best_source and source == best_source else 2 if duplicate_source and source == duplicate_source else 4
    item = {"source": source, "text": text, "signature": hashlib.sha1(text.encode()).hexdigest()[:12], "rank": rank}
    hits.append(item)
    if source == duplicate_source:
        hits.append({**item, "rank": 3})
print(json.dumps(hits[:request["limit"]]))
`

describe("Memory.hybridSearch", () => {
  it.live("preserves FTS ordering and numeric BM25 scores when semantic retrieval is disabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "false"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        yield* Effect.promise(() => fs.mkdir(path.join(root, "global"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "global", "first.md"), "rareterm commonterm"))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "global", "second.md"), "commonterm"))

        const lexical = yield* memory.search({ query: "rareterm commonterm" })
        const hybrid = yield* memory.hybridSearch({ query: "rareterm commonterm" })
        expect(hybrid.map((row) => row.path)).toEqual(lexical.map((row) => row.path))
        expect(hybrid.map((row) => row.score)).toEqual(lexical.map((row) => row.score))
        expect(hybrid.every((row) => row.retrieval === "lexical")).toBe(true)
      }),
    ),
  )

  it.live("limits implicit unscoped hybrid search to global memory without trusted current IDs", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "true"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        yield* Effect.promise(() => fs.mkdir(path.join(root, "global"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(root, "projects", "project_a"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "global", "shared.md"), "distinctive global phrase"))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "projects", "project_a", "private.md"), "distinctive project phrase"))

        const rows = yield* memory.hybridSearch({ query: "distinctive" })
        expect(rows.map((row) => row.path)).toContain(path.join(root, "global", "shared.md"))
        expect(rows.map((row) => row.path)).not.toContain(path.join(root, "projects", "project_a", "private.md"))
      }),
    ),
  )

  it.live("scopes lexical fallback before ranking and rejects foreign explicit IDs when current IDs are supplied", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "true"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        process.env.MIMOCODE_SEMINDEX_HELPER = path.join(yield* tmpdirScoped(), "missing-helper.py")
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const currentProject = Instance.current.project.id
        const currentSession = "ses_current_lexical"
        const foreignProject = path.join(root, "projects", "project_foreign", "foreign.md")
        const foreignSession = path.join(root, "sessions", "ses_foreign", "foreign.md")
        const current = path.join(root, "sessions", currentSession, "current.md")
        for (const [file, body] of [
          [foreignProject, "scopefox rareterm"],
          [foreignSession, "scopefox rareterm"],
          [current, "scopefox"],
        ]) {
          yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(file, body))
        }

        const publicSearch = yield* memory.search({ query: "scopefox rareterm", limit: 1 })
        expect([foreignProject, foreignSession]).toContain(publicSearch[0]?.path)
        const scopedFallback = yield* memory.hybridSearch({
          query: "scopefox rareterm",
          limit: 1,
          current_project_id: currentProject,
          current_session_id: currentSession,
        })
        expect(scopedFallback.map((row) => row.path)).toEqual([current])
        expect(scopedFallback[0]?.retrieval).toBe("lexical")
        expect(scopedFallback[0]?.score).toBeDefined()

        expect(yield* memory.hybridSearch({
          query: "scopefox rareterm",
          scope: "projects",
          scope_id: "project_foreign",
          current_project_id: currentProject,
          current_session_id: currentSession,
        })).toEqual([])
        expect(yield* memory.hybridSearch({
          query: "scopefox rareterm",
          scope: "sessions",
          scope_id: "ses_foreign",
          current_project_id: currentProject,
          current_session_id: currentSession,
        })).toEqual([])
      }),
    ),
  )

  it.live("retains trusted explicit scope IDs when current IDs are not supplied", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "true"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const file = path.join(root, "projects", "project_trusted", "trusted.md")
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "explicit trusted scope"))
        const rows = yield* memory.hybridSearch({ query: "explicit trusted", scope: "projects", scope_id: "project_trusted" })
        expect(rows.map((row) => row.path)).toContain(file)
        expect(yield* memory.hybridSearch({ query: "explicit trusted", scope: "projects" })).toEqual([])
        expect(yield* memory.hybridSearch({ query: "explicit trusted", scope: "sessions" })).toEqual([])
      }),
    ),
  )

  it.live("returns semantic-only current project/session and global results without crossing project or session scope", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "true"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        const temp = yield* tmpdirScoped()
        const marker = path.join(temp, "semantic-helper-marker")
        process.env.MIMOCODE_TEST_MARKER = marker
        const helperPath = path.join(temp, "semantic-helper.py")
        process.env.MIMOCODE_SEMINDEX_HELPER = helperPath
        yield* Effect.promise(() => Bun.write(helperPath, helper))
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const projectID = Instance.current.project.id
        const sessionID = "ses_current"
        const paths = [
          path.join(root, "global", "shared.md"),
          path.join(root, "projects", projectID, "same.md"),
          path.join(root, "projects", "project_other", "same.md"),
          path.join(root, "sessions", sessionID, "same.md"),
          path.join(root, "sessions", "ses_other", "same.md"),
        ]
        for (const file of paths) {
          yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(file, "semantic-only phrase"))
        }

        const rows = yield* memory.hybridSearch({
          query: "vectorfox",
          current_project_id: projectID,
          current_session_id: sessionID,
        })
        expect(rows.filter((row) => row.retrieval === "semantic").map((row) => row.path).sort()).toEqual(
          [paths[0], paths[1], paths[3]].sort(),
        )
        const projectRows = yield* memory.hybridSearch({
          query: "vectorfox",
          scope: "projects",
          current_project_id: projectID,
          current_session_id: sessionID,
        })
        expect(projectRows.filter((row) => row.retrieval === "semantic").map((row) => row.path)).toEqual([paths[1]])
        const sessionRows = yield* memory.hybridSearch({
          query: "vectorfox",
          scope: "sessions",
          current_project_id: projectID,
          current_session_id: sessionID,
        })
        expect(sessionRows.filter((row) => row.retrieval === "semantic").map((row) => row.path)).toEqual([paths[3]])
        expect(rows.every((row) => row.score === undefined)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("called")
      }),
    ),
  )

  it.live("drops semantic candidates whose excerpt or source is stale and bypasses exact IDs", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "true"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        const temp = yield* tmpdirScoped()
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const helperPath = path.join(temp, "semantic-helper.py")
        const marker = path.join(temp, "semantic-helper-marker")
        process.env.MIMOCODE_SEMINDEX_HELPER = helperPath
        process.env.MIMOCODE_TEST_MARKER = marker
        yield* Effect.promise(() => Bun.write(helperPath, helper))
        const file = path.join(root, "global", "stale.md")
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "changed body"))
        const stale = yield* memory.hybridSearch({ query: "semantic query", current_session_id: "ses_current" })
        expect(stale.map((row) => row.path)).not.toContain(file)

        const idFile = path.join(root, "global", "id.md")
        yield* Effect.promise(() => fs.writeFile(idFile, "ses_exactidentifier"))
        yield* Effect.promise(() => fs.rm(marker, { force: true }))
        const exact = yield* memory.hybridSearch({ query: "ses_exactidentifier", current_session_id: "ses_current" })
        expect(exact.find((row) => row.path === idFile)?.retrieval).toBe("lexical")
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
    ),
  )

  it.live("deduplicates chunks by source and drops a source deleted during provider search", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "true"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        const temp = yield* tmpdirScoped()
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        const helperPath = path.join(temp, "semantic-helper.py")
        process.env.MIMOCODE_SEMINDEX_HELPER = helperPath
        yield* Effect.promise(() => Bun.write(helperPath, helper))
        const duplicateFile = path.join(root, "global", "duplicate.md")
        const deletedFile = path.join(root, "global", "deleted.md")
        const semanticOtherFile = path.join(root, "global", "semantic-other.md")
        yield* Effect.promise(() => fs.mkdir(path.dirname(duplicateFile), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(duplicateFile, "lexicaltoken semantic-only phrase"))
        yield* Effect.promise(() => fs.writeFile(deletedFile, "semantic-only phrase"))
        yield* Effect.promise(() => fs.writeFile(semanticOtherFile, "semantic-only phrase"))

        const duplicate = yield* memory.hybridSearch({ query: "lexicaltoken" })
        expect(duplicate.filter((row) => row.path === duplicateFile)).toHaveLength(1)
        expect(duplicate.find((row) => row.path === duplicateFile)?.retrieval).toBe("both")

        process.env.MIMOCODE_TEST_DUPLICATE_SOURCE = deletedFile
        process.env.MIMOCODE_TEST_BEST_SOURCE = semanticOtherFile
        const fused = yield* memory.hybridSearch({ query: "raresemanticquery" })
        expect(fused.map((row) => row.path).slice(0, 2)).toEqual([semanticOtherFile, deletedFile])

        process.env.MIMOCODE_TEST_DELETE_SOURCE = deletedFile
        const deleted = yield* memory.hybridSearch({ query: "deletionquery" })
        expect(deleted.map((row) => row.path)).not.toContain(deletedFile)
      }),
    ),
  )

  it.live("bypasses semantic search for literal paths, flags, symbols, hashes, and stack traces", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_SEMANTIC_ENABLED = "true"
        process.env.MIMOCODE_SEMANTIC_MEMORY = "true"
        const temp = yield* tmpdirScoped()
        const helperPath = path.join(temp, "semantic-helper.py")
        const marker = path.join(temp, "semantic-helper-marker")
        process.env.MIMOCODE_SEMINDEX_HELPER = helperPath
        process.env.MIMOCODE_TEST_MARKER = marker
        yield* Effect.promise(() => Bun.write(helperPath, helper))
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        yield* Effect.promise(() => fs.mkdir(path.join(root, "global"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "global", "eligible.md"), "unrelated source content"))

        for (const query of [
          "/workspace/app/config/settings",
          "config.yaml",
          "--feature-toggle",
          "Database.prepare()",
          "deadbeefcafe112233445566",
          'Traceback (most recent call last): File "/workspace/app.py", line 12',
        ]) {
          yield* Effect.promise(() => fs.rm(marker, { force: true }))
          yield* memory.hybridSearch({ query })
          expect(yield* Effect.promise(() => Bun.file(marker).exists()), query).toBe(false)
        }

        yield* memory.hybridSearch({ query: "ordinary question about the failure" })
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("called")
      }),
    ),
  )
})
