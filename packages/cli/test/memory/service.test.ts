import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Database } from "../../src/storage"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { MemoryFtsTable } from "../../src/memory/fts.sql"
import { Memory } from "../../src/memory"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  // Clear shared in-memory DB rows so tests don't bleed into each other.
  Database.use((db) => db.delete(MemoryFtsTable).run())
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(Memory.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("Memory.search", () => {
  it.live("returns BM25-ranked matches across all scopes when no scope filter", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(root, "global"), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(root, "global", "auth.md"), "JWT signing with RS256 algorithm"),
        )
        yield* Effect.promise(() =>
          fs.writeFile(path.join(root, "global", "perf.md"), "database query optimization tips"),
        )

        const results = yield* memory.search({ query: "JWT" })
        expect(results.length).toBe(1)
        expect(results[0].path).toContain("auth.md")
        expect(results[0].score).toBeGreaterThan(0)
      }),
    ),
  )

  it.live("filters by scope", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(root, "global"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(root, "sessions/ses_a"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "global", "x.md"), "matching content"))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "sessions/ses_a", "x.md"), "matching content"))

        const globalOnly = yield* memory.search({ query: "matching", scope: "global" })
        expect(globalOnly.length).toBe(1)
        expect(globalOnly[0].path).toContain("/global/")

        const sessionOnly = yield* memory.search({ query: "matching", scope: "sessions" })
        expect(sessionOnly.length).toBe(1)
        expect(sessionOnly[0].path).toContain("/sessions/")
      }),
    ),
  )

  it.live("filters by scope_id when scope is sessions", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(root, "sessions/ses_a"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(root, "sessions/ses_b"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "sessions/ses_a", "x.md"), "alpha content"))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "sessions/ses_b", "x.md"), "alpha content"))

        const aOnly = yield* memory.search({ query: "alpha", scope: "sessions", scope_id: "ses_a" })
        expect(aOnly.length).toBe(1)
        expect(aOnly[0].path).toContain("ses_a")
      }),
    ),
  )

  it.live("respects limit", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(root, "global"), { recursive: true }))
        for (let i = 0; i < 15; i++) {
          yield* Effect.promise(() => fs.writeFile(path.join(root, "global", `f${i}.md`), `match ${i}`))
        }

        const r5 = yield* memory.search({ query: "match", limit: 5 })
        expect(r5.length).toBe(5)
      }),
    ),
  )

  it.live("does not crash on FTS5 special chars in query", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(root, "global"), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(root, "global", "x.md"), 'literal "quoted" content with stars'),
        )

        // Each of these contains a char that would crash the FTS5 MATCH parser
        // if the query were not phrase-wrapped: `"`, `*`, `(`, prefix `-`.
        for (const q of ['"quoted"', "wild*", "(paren)", "-not", "and"]) {
          const results = yield* memory.search({ query: q })
          expect(Array.isArray(results)).toBe(true)
        }
      }),
    ),
  )

  it.live("multi-word query OR-matches across tokens, splits punctuation", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const root = yield* memory.root()
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
        yield* Effect.promise(() => fs.mkdir(path.join(root, "global"), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(root, "global", "doc.md"),
            "T5.3 closure conversion abandoned — out of v0.1 scope per spec.md §4.4",
          ),
        )
        yield* Effect.promise(() =>
          fs.writeFile(path.join(root, "global", "other.md"), "unrelated text only"),
        )

        // Identifier with dot: tokenizer splits T5.3 into [t5, 3]; OR-join +
        // BM25 ranks doc.md (which contains both + "closure") top.
        const dotted = yield* memory.search({ query: "T5.3 closure" })
        expect(dotted.length).toBeGreaterThanOrEqual(1)
        expect(dotted[0].path).toContain("doc.md")

        // Multi-word: both words appear in doc.md, other.md has neither →
        // only doc.md is above the score floor.
        const both = yield* memory.search({ query: "abandoned scope" })
        expect(both.length).toBe(1)
        expect(both[0].path).toContain("doc.md")

        // OR semantics: one word present ("abandoned"), one absent
        // ("nonexistentterm") → still matches doc.md (unlike old AND, which
        // returned 0). This is the recall fix: a stray non-matching word no
        // longer zeroes the query.
        const orHit = yield* memory.search({ query: "abandoned nonexistentterm" })
        expect(orHit.length).toBe(1)
        expect(orHit[0].path).toContain("doc.md")

        // A query of ONLY absent words → genuinely 0.
        const trueMiss = yield* memory.search({ query: "nonexistentterm anotherbogusword" })
        expect(trueMiss.length).toBe(0)

        // Empty query returns empty array (early-return path).
        const empty = yield* memory.search({ query: "   " })
        expect(empty.length).toBe(0)
      }),
    ),
  )
})
