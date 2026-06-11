import { describe, expect, test } from "bun:test"
import { evalScript } from "../../src/workflow/sandbox"

describe("Sandbox basic eval", () => {
  test("runs a script body and returns the value", async () => {
    const result = await evalScript("return 1 + 1", {})
    expect(result).toBe(2)
  })

  test("returns an object result (dumped out of the guest)", async () => {
    const result = await evalScript(`return { a: 1, b: [2, 3] }`, {})
    expect(result).toEqual({ a: 1, b: [2, 3] })
  })
})

describe("Sandbox async host hooks", () => {
  test("awaits an async host fn and returns its resolved value", async () => {
    const calls: string[] = []
    const hooks = {
      agent: async (prompt: unknown) => {
        calls.push(prompt as string)
        await new Promise((r) => setTimeout(r, 10))
        return `echo:${prompt}`
      },
    }
    const result = await evalScript(`return await agent("hi")`, hooks)
    expect(result).toBe("echo:hi")
    expect(calls).toEqual(["hi"])
  })

  test("parallel() of many async hooks all resolve (no deadlock)", async () => {
    const hooks = {
      agent: async (n: unknown) => {
        await new Promise((r) => setTimeout(r, 5))
        return `done-${n}`
      },
    }
    const body = `
      const thunks = []
      for (let i = 0; i < 10; i++) thunks.push(() => agent(i))
      const results = await parallel(thunks)
      return results.length
    `
    const result = await evalScript(body, hooks)
    expect(result).toBe(10)
  })

  test("a hook resolving after the slow-poll back-off (>SLOW_MS) still delivers", async () => {
    // The adaptive pump backs off to ~50ms once the guest has been parked.
    // A hook that takes 120ms to resolve leaves the guest idle long enough for
    // the pump to reach the slow cadence; the result must STILL arrive intact.
    // The host-settle self-pump in injectHooks resumes the guest the instant
    // the promise resolves, so the back-off cannot lose the value.
    const hooks = {
      agent: async (prompt: unknown) => {
        await new Promise((r) => setTimeout(r, 120))
        return `slow:${prompt}`
      },
    }
    const result = await evalScript(`return await agent("park")`, hooks)
    expect(result).toBe("slow:park")
  })

  test("idle parking does not busy-spin (far fewer than 1/ms wakeups)", async () => {
    // Wrap setTimeout to count how often a sub-`SLOW_MS` (i.e. FAST_MS=1ms)
    // pump tick is scheduled while the guest is parked on a single slow hook.
    // A fixed 1ms interval would schedule ~150 fast ticks over a 150ms park;
    // the adaptive pump stays fast for only a short window then backs off, so
    // the fast-tick count must be a small fraction of the parked duration.
    const realSetTimeout = globalThis.setTimeout
    let fastTicks = 0
    // Patch the global for measurement only; restored in finally.
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 1) fastTicks++
      return realSetTimeout(fn, ms, ...rest)
    }) as typeof setTimeout
    try {
      const hooks = {
        agent: async (prompt: unknown) => {
          await new Promise((r) => realSetTimeout(r, 150))
          return `slow:${prompt}`
        },
      }
      const result = await evalScript(`return await agent("park")`, hooks)
      expect(result).toBe("slow:park")
      // FAST_WINDOW=50 fast ticks max before back-off engages; allow generous
      // headroom for the brief fast burst at start/around the single settle.
      // The key assertion: nowhere near the ~150 a fixed-1ms loop would produce.
      expect(fastTicks).toBeLessThan(120)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})

describe("Sandbox isolation + determinism", () => {
  test("host globals are unreachable", async () => {
    const result = await evalScript(
      `return [typeof process, typeof Bun, typeof require, typeof globalThis.process]`,
      {},
    )
    expect(result).toEqual(["undefined", "undefined", "undefined", "undefined"])
  })

  test("constructor escape does not reach host process", async () => {
    const result = await evalScript(
      `try { return this.constructor.constructor("return typeof process")() } catch (e) { return "blocked" }`,
      {},
    )
    expect(result === "undefined" || result === "blocked").toBe(true)
  })

  test("Date is removed, Math.random is a seeded deterministic PRNG", async () => {
    // Date is deleted (nondeterministic wall-clock). Math.random is NOT deleted —
    // it's replaced with a seeded PRNG. Same seed (or no seed → default) produces
    // the same sequence (resume replay invariant). Different seeds produce
    // different sequences (so unrelated runs of the same script — keyed on a hash
    // of runID by the runtime — get fresh coverage for sampling-style scripts).
    const types = await evalScript(`return [typeof Date, typeof Math.random]`, {})
    expect(types).toEqual(["undefined", "function"])
    const a = (await evalScript(`return [Math.random(), Math.random(), Math.random()]`, {})) as number[]
    const b = (await evalScript(`return [Math.random(), Math.random(), Math.random()]`, {})) as number[]
    expect(a).toEqual(b) // same default seed ⇒ same sequence (replay invariant)
    expect(a[0]).toBeGreaterThanOrEqual(0)
    expect(a[0]).toBeLessThan(1)
    expect(a[0]).not.toEqual(a[1]) // but varies within a run
    // Same explicit seed ⇒ same sequence (resume of same runID path).
    const c = (await evalScript(`return [Math.random(), Math.random()]`, {}, { seed: 42 })) as number[]
    const d = (await evalScript(`return [Math.random(), Math.random()]`, {}, { seed: 42 })) as number[]
    expect(c).toEqual(d)
    // Different seeds ⇒ different sequences (sampling-style scripts keyed on
    // runID-derived seeds get fresh coverage across unrelated runs).
    const e = (await evalScript(`return [Math.random(), Math.random()]`, {}, { seed: 999 })) as number[]
    expect(e).not.toEqual(c)
  })

  test("WeakRef and FinalizationRegistry are removed in-guest (GC-timing nondeterminism)", async () => {
    const result = await evalScript(
      `return [typeof WeakRef, typeof FinalizationRegistry]`,
      {},
    )
    expect(result).toEqual(["undefined", "undefined"])
  })

  test("a script touching a stripped global fails loudly (ReferenceError), not silently", async () => {
    // `delete` leaves the binding genuinely absent, so `new WeakRef(...)` is a
    // ReferenceError that surfaces as a rejected evalScript — a script can't
    // silently diverge on GC timing, it fails.
    await expect(evalScript(`return new WeakRef({})`, {})).rejects.toThrow()
  })
})

describe("Sandbox resource guards + hygiene", () => {
  test("infinite loop is interrupted by the deadline", async () => {
    await expect(evalScript(`while (true) {}`, {}, { deadlineMs: 300 })).rejects.toThrow()
  })

  test("100 sequential evals do not abort the process (no handle leak)", async () => {
    for (let i = 0; i < 100; i++) {
      const r = await evalScript(`return ${i}`, {})
      expect(r).toBe(i)
    }
  })

  test("a throwing script still disposes cleanly (next eval works)", async () => {
    await expect(evalScript(`throw new Error("boom")`, {})).rejects.toThrow("boom")
    const r = await evalScript(`return "ok"`, {})
    expect(r).toBe("ok")
  })
})

describe("Sandbox prelude (parallel/pipeline/args)", () => {
  test("parallel is provided without a guest helper", async () => {
    const hooks = { agent: async (n: unknown) => `done-${n}` }
    const body = `return (await parallel([() => agent("a"), () => agent("b")]))`
    const result = await evalScript(body, hooks)
    expect(result).toEqual(["done-a", "done-b"])
  })

  test("a throwing thunk in parallel rejects the batch (fails loud, message survives)", async () => {
    const hooks = { agent: async () => { throw new Error("boom-thunk") } }
    const body = `return await parallel([() => agent("a")])`
    await expect(evalScript(body, hooks)).rejects.toThrow(/boom-thunk/)
  })

  test("pipeline runs each item through stages, no inter-stage barrier", async () => {
    const body = `
      const r = await pipeline([1, 2], (n) => n + 1, (n) => n * 10)
      return r
    `
    const result = await evalScript(body, {})
    expect(result).toEqual([20, 30])
  })

  test("a throwing stage rejects the batch (fails loud, message survives)", async () => {
    const body = `
      const r = await pipeline([1, 2], (n) => { if (n === 1) throw new Error("boom-stage"); return n }, (n) => n * 10)
      return r
    `
    await expect(evalScript(body, {})).rejects.toThrow(/boom-stage/)
  })

  test("args is injected as a guest global", async () => {
    const result = await evalScript(`return args.foo`, {}, { args: { foo: 42 } })
    expect(result).toBe(42)
  })
})

describe("Sandbox unsettled-hook hygiene", () => {
  test("a fire-and-forget hook call (no await) does not abort the process", async () => {
    // The script returns immediately while agent() is still in flight.
    // Before the fix this hard-aborts at vm.dispose(); after, it is clean.
    const hooks = { agent: async () => { await new Promise((r) => setTimeout(r, 15)); return 1 } }
    for (let i = 0; i < 40; i++) {
      const r = await evalScript(`agent(); return "fast"`, hooks)
      expect(r).toBe("fast")
    }
  })

  test("a hook that rejects after the script returns does not crash", async () => {
    const hooks = { agent: async () => { await new Promise((r) => setTimeout(r, 15)); throw new Error("late") } }
    for (let i = 0; i < 20; i++) {
      const r = await evalScript(`agent(); return "ok"`, hooks)
      expect(r).toBe("ok")
    }
  })
})

describe("Sandbox URL polyfill", () => {
  test("new URL exposes hostname and pathname", async () => {
    const result = await evalScript(
      `const u = new URL("https://www.Example.com/Foo/Bar/?q=1#h"); return { host: u.hostname, path: u.pathname }`,
      {},
    )
    expect(result).toEqual({ host: "www.Example.com", path: "/Foo/Bar/" })
  })

  test("invalid URL throws (so script try/catch fallbacks work)", async () => {
    const result = await evalScript(
      `try { new URL("not a url"); return "no-throw" } catch { return "threw" }`,
      {},
    )
    expect(result).toBe("threw")
  })

  test("deep-research normURL dedup shape works end to end", async () => {
    const body = `
      const normURL = u => {
        try {
          const p = new URL(u)
          return (p.hostname.replace(/^www\\./, "") + p.pathname.replace(/\\/$/, "")).toLowerCase()
        } catch { return u.toLowerCase() }
      }
      return [normURL("https://www.Example.com/A/"), normURL("HTTPS://example.com/A"), normURL("garbage")]
    `
    const result = await evalScript(body, {})
    expect(result).toEqual(["example.com/a", "example.com/a", "garbage"])
  })
})
