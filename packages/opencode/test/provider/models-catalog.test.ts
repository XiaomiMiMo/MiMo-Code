import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile, symlink } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import os from "node:os"
import path from "node:path"
import { createCatalog, validateCatalog } from "../../src/provider/models-catalog"

const model = {
  id: "m",
  name: "Model",
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: true,
  tool_call: true,
  limit: { context: 100, output: 10 },
}
const baseline = { native: { id: "native", name: "Native", env: [], models: { m: model } } }
async function fixture(run: (cache: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "models-catalog-"))
  try {
    await run(path.join(dir, "models.json"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// [TP-R1-01] Local baseline remains available while refresh is slow/offline.
test("local snapshot + cache field merge, cloned reads and single-flight refresh", () =>
  fixture(async (cache) => {
    await writeFile(
      cache,
      JSON.stringify({
        native: { ...baseline.native, models: { m: { ...model, name: "Cached" } } },
        other: { ...baseline.native, id: "other" },
      }),
    )
    let calls = 0
    let resolve!: (r: Response) => void
    const catalog = createCatalog({
      cache,
      snapshot: async () => baseline,
      fetch: () => {
        calls++
        return new Promise((r) => {
          resolve = r
        })
      },
    })
    const local = await catalog.get()
    expect(local.native.models.m.name).toBe("Cached")
    local.native.name = "mutated"
    expect((await catalog.get()).native.name).toBe("Native")
    const a = catalog.refresh(true)
    const b = catalog.refresh(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(1)
    expect((await catalog.get()).other).toBeDefined()
    resolve(Response.json({ native: { ...baseline.native, name: "Updated" } }))
    await Promise.all([a, b])
    expect((await catalog.get()).native.name).toBe("Updated")
    expect((await catalog.get()).other).toBeUndefined()
  }))

test("failed/invalid responses retain last-good disk and memory; only changes notify; TTL", () =>
  fixture(async (cache) => {
    let response = Response.json(baseline)
    let calls = 0
    const catalog = createCatalog({
      cache,
      snapshot: async () => baseline,
      fetch: async () => {
        calls++
        return response
      },
    })
    let events = 0
    catalog.subscribe(() => {
      events++
    })
    await catalog.refresh(true)
    const disk = await readFile(cache, "utf8")
    for (const bad of [
      new Response("oops"),
      Response.json({}),
      Response.json({ error: "bad" }),
      Response.json(baseline, { status: 500 }),
    ]) {
      response = bad
      await catalog.refresh(true)
      expect(await readFile(cache, "utf8")).toBe(disk)
      expect(await catalog.get()).toEqual(validateCatalog(baseline))
    }
    expect(events).toBe(0)
    response = Response.json({ native: { ...baseline.native, name: "Next" } })
    await catalog.refresh(true)
    expect(events).toBe(1)
    const before = calls
    await catalog.refresh()
    expect(calls).toBe(before)
  }))

test("explicit PATH is exclusive and never overwritten by network", () =>
  fixture(async (cache) => {
    const explicit = cache + ".custom"
    await writeFile(explicit, JSON.stringify({ only: { ...baseline.native, id: "only" } }))
    const catalog = createCatalog({
      cache,
      explicit,
      snapshot: async () => baseline,
      fetch: async () => Response.json(baseline),
    })
    expect(Object.keys(await catalog.get())).toEqual(["only"])
    await catalog.refresh(true)
    expect(Object.keys(await catalog.get())).toEqual(["only"])
  }))

test("missing or malformed cache falls back to snapshot; auto refresh is gated but force still fetches", () =>
  fixture(async (cache) => {
    let calls = 0
    const catalog = createCatalog({
      cache,
      snapshot: async () => baseline,
      disabled: () => true,
      fetch: async () => {
        calls++
        throw new Error("offline")
      },
    })
    const stop = catalog.startRefresh()
    await catalog.refresh()
    expect(await catalog.get()).toEqual(validateCatalog(baseline))
    expect(calls).toBe(0)
    // Explicit force is not gated by DISABLE_MODELS_FETCH (matches pre-catalog contract).
    await catalog.refresh(true)
    expect(calls).toBe(1)
    expect(await catalog.get()).toEqual(validateCatalog(baseline))
    stop()
    await writeFile(cache, "{}")
    const enabled = createCatalog({
      cache,
      snapshot: async () => baseline,
      fetch: async () => {
        calls++
        throw new Error("offline")
      },
    })
    await enabled.refresh()
    expect(calls).toBe(2)
    expect(await enabled.get()).toEqual(validateCatalog(baseline))
    expect(await readFile(cache, "utf8")).toBe("{}")
  }))

test("snapshot does not revive entities dropped by a successful authoritative refresh", () =>
  fixture(async (cache) => {
    const withGhost = {
      native: baseline.native,
      ghost: { ...baseline.native, id: "ghost", models: { gone: { ...model, id: "gone" } } },
    }
    await writeFile(
      cache,
      JSON.stringify({
        native: baseline.native,
        ghost: withGhost.ghost,
      }),
    )
    const catalog = createCatalog({
      cache,
      snapshot: async () => withGhost,
      fetch: async () => Response.json({ native: { ...baseline.native, name: "Live" } }),
    })
    const local = await catalog.get()
    expect(local.ghost).toBeDefined()
    await catalog.refresh(true)
    expect((await catalog.get()).ghost).toBeUndefined()
    expect((await catalog.get()).native.name).toBe("Live")
  }))

test("force is not swallowed by an in-flight non-force refresh", () =>
  fixture(async (cache) => {
    // Stale mtime so non-force takes the fetch path and can hold the gate.
    await writeFile(cache, JSON.stringify(baseline))
    const { utimes } = await import("node:fs/promises")
    await utimes(cache, new Date(Date.now() - 10 * 60 * 1000), new Date(Date.now() - 10 * 60 * 1000))
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const catalog = createCatalog({
      cache,
      snapshot: async () => baseline,
      fetch: async () => {
        calls++
        if (calls === 1) await gate
        return Response.json({ native: { ...baseline.native, name: `Fetched${calls}` } })
      },
    })
    const background = catalog.refresh()
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(1)
    const forced = catalog.refresh(true)
    release()
    await Promise.all([background, forced])
    // Force must not join the non-force flight without a subsequent fetch.
    expect(calls).toBe(2)
    expect((await catalog.get()).native.name).toBe("Fetched2")
  }))

test("invalid explicit PATH fails closed and never falls back to the public cache", () =>
  fixture(async (cache) => {
    const explicit = cache + ".custom"
    await writeFile(cache, JSON.stringify(baseline))
    await writeFile(explicit, JSON.stringify({ native: { id: "native" } }))
    let calls = 0
    const catalog = createCatalog({
      cache,
      explicit,
      snapshot: async () => baseline,
      fetch: async () => {
        calls++
        return Response.json(baseline)
      },
    })
    expect(await catalog.get()).toEqual({})
    await catalog.refresh(true)
    expect(await catalog.get()).toEqual({})
    expect(calls).toBe(0)
    expect(await readFile(cache, "utf8")).toBe(JSON.stringify(baseline))
  }))

test("explicit PATH short-circuits update: no fetch and no shared-cache rewrite", () =>
  fixture(async (cache) => {
    const explicit = cache + ".custom"
    await writeFile(explicit, JSON.stringify({ only: { ...baseline.native, id: "only" } }))
    let calls = 0
    const catalog = createCatalog({
      cache,
      explicit,
      snapshot: async () => baseline,
      fetch: async () => {
        calls++
        return Response.json(baseline)
      },
    })
    await catalog.refresh()
    await catalog.refresh(true)
    expect(calls).toBe(0)
    expect(Object.keys(await catalog.get())).toEqual(["only"])
  }))

test("reset discards an in-flight load settle", async () =>
  fixture(async (cache) => {
    let resolveSnapshot!: (v: unknown) => void
    const catalog = createCatalog({
      cache,
      snapshot: () =>
        new Promise((r) => {
          resolveSnapshot = r
        }),
      fetch: async () => Response.json(baseline),
    })
    const first = catalog.get()
    catalog.reset()
    resolveSnapshot({ native: { ...baseline.native, name: "AfterReset" } })
    await first
    const second = await catalog.get()
    expect(second.native.name).toBe("AfterReset")
  }))

test("same-source deep merge preserves omitted fields and explicit false/zero; listeners unsubscribe", () =>
  fixture(async (cache) => {
    const snapshot = {
      native: {
        ...baseline.native,
        models: { m: { ...model, reasoning: true, cost: { input: 5, output: 6 }, provider: { npm: "sdk" } } },
      },
    }
    const next = { native: { ...baseline.native, models: { m: { ...model, cost: { input: 0, output: 0 } } } } }
    const catalog = createCatalog({ cache, snapshot: async () => snapshot, fetch: async () => Response.json(next) })
    let events = 0
    const unsubscribe = catalog.subscribe(() => {
      events++
    })
    await catalog.refresh(true)
    const result = (await catalog.get()).native.models.m
    expect(result.reasoning).toBe(false)
    expect(result.cost?.input).toBe(0)
    expect(result.provider?.npm).toBe("sdk")
    expect(events).toBe(1)
    await catalog.refresh(true)
    expect(events).toBe(1)
    unsubscribe()
  }))

test("plain Node runs bundled lifecycle offline without Bun globals", () =>
  fixture(async (cache) => {
    const output = cache + ".mjs"
    const build = await Bun.build({
      entrypoints: [path.resolve("src/provider/models-catalog.ts")],
      target: "node",
      format: "esm",
    })
    expect(build.success).toBe(true)
    await writeFile(output, await build.outputs[0].text())
    const code = `import { createCatalog } from ${JSON.stringify(pathToFileURL(output).href)};
    if (typeof Bun !== 'undefined') throw new Error('not plain Node');
    const catalog = createCatalog({ cache: ${JSON.stringify(cache)}, snapshot: async () => (${JSON.stringify(baseline)}), fetch: async () => { throw new Error('offline') } });
    const local = await catalog.get();
    if (!local.native.models.m) throw new Error('missing local baseline');
    await catalog.refresh(true);
    if (!(await catalog.get()).native.models.m) throw new Error('lost baseline');
    console.log('node-offline-ok');`
    expect(execFileSync("node", ["--input-type=module", "-e", code], { encoding: "utf8" })).toContain("node-offline-ok")
  }))

// [TP-R5-04] Copy the actual generator into an isolated package layout: its
// import.meta.url-relative output must never point at the checked-out snapshot.
test("generate accepts valid offline input without fetching and writes an importable snapshot", () =>
  fixture(async (cache) => {
    const root = path.dirname(cache)
    const output = path.join(root, "script", "generate.ts")
    await mkdir(path.dirname(output), { recursive: true })
    await mkdir(path.join(root, "src/provider"), { recursive: true })
    await copyFile(path.resolve("script/generate.ts"), output)
    await copyFile(path.resolve("src/provider/models-schema.ts"), path.join(root, "src/provider/models-schema.ts"))
    await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir")
    await writeFile(cache, JSON.stringify(baseline))
    const child = Bun.spawn(["bun", output], {
      env: { ...Bun.env, MODELS_DEV_API_JSON: cache, MIMOCODE_MODELS_URL: "http://127.0.0.1:1" },
      stdout: "pipe", stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toContain("Generated models-snapshot.js")
    const generated = path.join(path.dirname(cache), "src/provider/models-snapshot.js")
    expect((await import(pathToFileURL(generated).href)).snapshot).toEqual(validateCatalog(baseline))
    expect(await readFile(generated.replace(/\.js$/, ".d.ts"), "utf8")).toContain("export declare const snapshot")
  }))

test("generate refuses empty or malformed offline baseline before writing snapshot", () =>
  fixture(async (cache) => {
    for (const raw of ["{}", "not-json"]) {
      await writeFile(cache, raw)
      const process = Bun.spawn(["bun", "script/generate.ts"], {
        env: { ...Bun.env, MODELS_DEV_API_JSON: cache },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await process.exited).not.toBe(0)
      expect(await new Response(process.stdout).text()).not.toContain("Generated models-snapshot")
    }
  }))

test("explicit empty catalog stays exclusive", () =>
  fixture(async (cache) => {
    const explicit = cache + ".custom"
    await writeFile(explicit, "{}")
    const catalog = createCatalog({
      cache,
      explicit,
      snapshot: async () => baseline,
      fetch: async () => Response.json(baseline),
    })
    expect(Object.keys(await catalog.get())).toEqual([])
    await catalog.refresh(true)
    expect(Object.keys(await catalog.get())).toEqual([])
  }))

test("existing operator catalog fixture remains readable", async () => {
  validateCatalog(JSON.parse(await readFile(path.resolve("test/tool/fixtures/models-api.json"), "utf8")), true)
})

test("validator rejects invalid/empty catalog but accepts forward-compatible metadata", () => {
  for (const input of [{}, [], { native: {} }, { native: { ...baseline.native, models: { bad: {} } } }])
    expect(() => validateCatalog(input)).toThrow()
  expect(validateCatalog({ native: { ...baseline.native, future: "ok" } }).native.name).toBe("Native")
})
