import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { Global } from "../../src/global"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

describe("Auth", () => {
  it.live("set normalizes trailing slashes in keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeDefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set cleans up pre-existing trailing-slash entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "old",
        })
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "new",
        })
        const data = yield* auth.all()
        const keys = Object.keys(data).filter((key) => key.includes("example.com"))
        expect(keys).toEqual(["https://example.com"])
        const entry = data["https://example.com"]!
        expect(entry.type).toBe("wellknown")
        if (entry.type === "wellknown") expect(entry.token).toBe("new")
      }),
    ),
  )

  it.live("remove deletes both trailing-slash and normalized keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        yield* auth.remove("https://example.com/")
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeUndefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set and remove are no-ops on keys without trailing slashes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("anthropic", {
          type: "api",
          key: "sk-test",
        })
        const data = yield* auth.all()
        expect(data["anthropic"]).toBeDefined()
        yield* auth.remove("anthropic")
        const after = yield* auth.all()
        expect(after["anthropic"]).toBeUndefined()
      }),
    ),
  )

  // Auth.inject is the in-process channel for an embedding host (the desktop runs the engine
  // in-process). It exists so credentials never have to sit in MIMOCODE_AUTH_CONTENT, which every
  // child the engine spawns would inherit.
  it.live("inject supplies credentials without touching the environment", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        Auth.inject(JSON.stringify({ xiaomi: { type: "api", key: "sk-injected" } }))
        const data = yield* (yield* Auth.Service).all()
        expect(data["xiaomi"]).toEqual({ type: "api", key: "sk-injected" })
        expect(process.env.MIMOCODE_AUTH_CONTENT).toBeUndefined()
        Auth.inject(undefined)
      }),
    ),
  )

  it.live("inject wins over the env channel, and clearing it falls back", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_AUTH_CONTENT = JSON.stringify({ xiaomi: { type: "api", key: "sk-env" } })
        Auth.inject(JSON.stringify({ xiaomi: { type: "api", key: "sk-injected" } }))
        const auth = yield* Auth.Service
        expect((yield* auth.all())["xiaomi"]).toEqual({ type: "api", key: "sk-injected" })
        Auth.inject(undefined)
        expect((yield* auth.all())["xiaomi"]).toEqual({ type: "api", key: "sk-env" })
        delete process.env.MIMOCODE_AUTH_CONTENT
      }),
    ),
  )

  // A write through this service is authoritative. If `inject` (or the env fallback) is active and a
  // mutation only reaches the file, every later read keeps returning the pre-write snapshot — an
  // OAuth refresh, a key rotation or a logout looks like it succeeded and changes nothing.
  it.live("set is visible to later reads while inject is active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        Auth.inject(JSON.stringify({ xiaomi: { type: "api", key: "sk-old" } }))
        const auth = yield* Auth.Service
        yield* auth.set("xiaomi", { type: "api", key: "sk-new" })
        expect((yield* auth.all())["xiaomi"]).toEqual({ type: "api", key: "sk-new" })
        Auth.inject(undefined)
      }),
    ),
  )

  it.live("remove is visible to later reads while inject is active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        Auth.inject(JSON.stringify({ xiaomi: { type: "api", key: "sk-old" }, other: { type: "api", key: "sk-keep" } }))
        const auth = yield* Auth.Service
        yield* auth.remove("xiaomi")
        const data = yield* auth.all()
        expect(data["xiaomi"]).toBeUndefined()
        expect(data["other"]).toEqual({ type: "api", key: "sk-keep" })
        Auth.inject(undefined)
      }),
    ),
  )

  // Same defect on the env channel, which predates `inject`: the var shadows the file, so a token
  // refresh inside a workspace child was invisible to that same child.
  it.live("set is visible to later reads while the env channel is active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.MIMOCODE_AUTH_CONTENT = JSON.stringify({ xiaomi: { type: "api", key: "sk-env" } })
        const auth = yield* Auth.Service
        yield* auth.set("xiaomi", { type: "api", key: "sk-rotated" })
        expect((yield* auth.all())["xiaomi"]).toEqual({ type: "api", key: "sk-rotated" })
        delete process.env.MIMOCODE_AUTH_CONTENT
        Auth.inject(undefined)
      }),
    ),
  )

  // The snapshot moves only after the write lands. If it moved first, a failed write would leave the
  // in-memory credentials ahead of the file — the next process would silently run on the old ones.
  it.live("a failed write leaves the snapshot untouched", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const file = path.join(Global.Path.data, "auth.json")
        yield* Effect.promise(async () => {
          await fs.rm(file, { force: true })
          await fs.mkdir(file, { recursive: true }) // writing over a directory fails
        })
        Auth.inject(JSON.stringify({ xiaomi: { type: "api", key: "sk-old" } }))
        const auth = yield* Auth.Service
        const result = yield* Effect.result(auth.set("xiaomi", { type: "api", key: "sk-new" }))
        expect(result._tag).toBe("Failure")
        expect((yield* auth.all())["xiaomi"]).toEqual({ type: "api", key: "sk-old" })
        Auth.inject(undefined)
        yield* Effect.promise(() => fs.rm(file, { recursive: true, force: true }))
      }),
    ),
  )
})
