import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { Global } from "../../src/global"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))
const file = path.join(Global.Path.data, "auth.json")

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

  // A host (MiMo Desktop's platform link) may store non-string metadata such as
  // `platform_linked: true`. The CLI must still read the credential and must never
  // drop such entries when it rewrites the file.
  const linked = {
    type: "api",
    key: "sk-linked",
    metadata: { uid: "42", base_url: "https://api.example.com/v1", platform_linked: true },
  }

  it.live("all keeps api entries whose metadata carries non-string values", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ xiaomi: linked })))
        const data = yield* (yield* Auth.Service).all()
        expect(data["xiaomi"]).toEqual(
          new Auth.Api({ type: "api", key: "sk-linked", metadata: { uid: "42", base_url: "https://api.example.com/v1" } }),
        )
        yield* Effect.promise(() => fs.rm(file, { force: true }))
      }),
    ),
  )

  it.live("set and remove preserve sibling entries verbatim", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const unknown = { type: "future", value: 1 }
        yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ xiaomi: linked, other: unknown })))
        const auth = yield* Auth.Service
        yield* auth.set("xiaomi-token-plan-cn", { type: "api", key: "tp-new" })
        const written = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
        expect(written).toEqual({ xiaomi: linked, other: unknown, "xiaomi-token-plan-cn": { type: "api", key: "tp-new" } })
        yield* auth.remove("xiaomi-token-plan-cn")
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))).toEqual({ xiaomi: linked, other: unknown })
        yield* Effect.promise(() => fs.rm(file, { force: true }))
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
})
