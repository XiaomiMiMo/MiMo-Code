import { afterEach, expect, test } from "bun:test"
import { registerDisposer } from "@/effect/instance-registry"
import { Instance } from "../../src/project/instance"
import { GlobalRoutes } from "../../src/server/routes/global"
import { AppRuntime } from "../../src/effect/app-runtime"
import { SessionRunState } from "../../src/session/run-state"
import { ActorExecution } from "../../src/actor/execution"
import { Session } from "../../src/session"
import { Server } from "../../src/server/server"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Instance.disposeAll())

test("global disposal skips instances that are still in use", async () => {
  await using tmp = await tmpdir()
  let entered!: () => void
  let finish!: () => void
  const active = new Promise<void>((resolve) => (entered = resolve))
  const blocked = new Promise<void>((resolve) => (finish = resolve))
  let disposals = 0
  const unregister = registerDisposer(async (directory) => {
    if (directory === tmp.path) disposals++
  })

  try {
    const running = Instance.provide({
      directory: tmp.path,
      fn: async () => {
        entered()
        await blocked
      },
    })
    await active
    await Instance.disposeAll()
    expect(disposals).toBe(0)

    finish()
    await running
    await Instance.disposeDirectory(tmp.path)
    expect(disposals).toBe(1)
  } finally {
    finish()
    unregister()
    await Instance.disposeDirectory(tmp.path)
  }
})

test("prompt_async acknowledgement retains the instance until its background run settles", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const server = startScriptedLLMServer([{ lines: textStopResponse("DONE"), beforeReply: async () => {
    entered.resolve()
    await finish.promise
  } }])
  await using tmp = await tmpdir({
    git: true,
    config: {
      provider: { e2e: {
        npm: "@ai-sdk/openai-compatible", env: [],
        options: { apiKey: "fixture", baseURL: `${server.origin}/v1` },
        models: { "background-model": { name: "Background fixture", tool_call: true, limit: { context: 128000, output: 4096 } } },
      } },
    },
  })
  try {
    const session = await Instance.provide({
      directory: tmp.path,
      fn: () => AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "background refresh" }))),
    })
    await Instance.disposeAll()
    expect(Instance.refreshStatus(tmp.path).state).toBe("applied")
    const app = Server.Default().app
    const events = await app.request(`/event?directory=${encodeURIComponent(tmp.path)}`)
    expect(events.status).toBe(200)
    const reader = events.body!.getReader()
    const first = await Promise.race([reader.read(), Bun.sleep(2_000).then(() => { throw new Error("event stream did not flush") })])
    expect(new TextDecoder().decode(first.value)).toContain("server.connected")
    await reader.cancel()
    const response = await app.request(`/session/${session.id}/prompt_async?directory=${encodeURIComponent(tmp.path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "e2e", modelID: "background-model" },
        parts: [{ type: "text", text: "Continue" }],
      }),
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ receiptId: expect.any(String) })
    await entered.promise
    await Instance.disposeAll()
    expect(Instance.refreshStatus(tmp.path).state).toBe("pending")
    finish.resolve()
    for (let i = 0; i < 50 && Instance.refreshStatus(tmp.path).state !== "applied"; i++) await Bun.sleep(20)
    expect(Instance.refreshStatus(tmp.path).state).toBe("applied")
  } finally {
    finish.resolve()
    await server.stop()
  }
}, 15_000)

test("rejected prompt_async admission releases its instance claim", async () => {
  await using tmp = await tmpdir()
  const session = await Instance.provide({
    directory: tmp.path,
    fn: () => AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "rejected admission" }))),
  })
  const response = await Server.Default().app.request(`/session/${session.id}/prompt_async?directory=${encodeURIComponent(tmp.path)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "missing-agent", parts: [{ type: "text", text: "Continue" }] }),
  })
  expect(response.status).toBe(500)
  expect(await response.json()).not.toHaveProperty("receiptId")
  await Instance.disposeAll()
  expect(Instance.refreshStatus(tmp.path).state).toBe("applied")
})

test("a detached main runner keeps its instance alive after the request exits", async () => {
  await using tmp = await tmpdir()
  const { id } = await Instance.provide({
    directory: tmp.path,
    fn: () => AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "detached refresh" }))),
  })
  let disposals = 0
  const unregister = registerDisposer(async (directory) => {
    if (directory === tmp.path) disposals++
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: () => AppRuntime.runPromise(SessionRunState.Service.use((state) =>
        state.start(id, "main", Effect.succeed({ info: {}, parts: [] } as never), Effect.never as never),
      )),
    })
    await Instance.disposeAll()
    expect(disposals).toBe(0)
    expect(Instance.refreshStatus(tmp.path).state).toBe("pending")
    await Instance.provide({
      directory: tmp.path,
      fn: () => AppRuntime.runPromise(SessionRunState.Service.use((state) => state.cancel(id))),
    })
    await Bun.sleep(20)
    expect(disposals).toBe(1)
    expect(Instance.refreshStatus(tmp.path).state).toBe("applied")
  } finally {
    unregister()
  }
})

test("an actor reservation protects the directory before its runner starts", async () => {
  await using tmp = await tmpdir()
  const { id } = await Instance.provide({
    directory: tmp.path,
    fn: () => AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "actor reservation" }))),
  })
  let disposals = 0
  const unregister = registerDisposer(async (directory) => {
    if (directory === tmp.path) disposals++
  })
  try {
    const execution = await Instance.provide({
      directory: tmp.path,
      fn: () => AppRuntime.runPromise(ActorExecution.Service.use((svc) => svc.reserve(id, "actor-1"))),
    })
    await Instance.disposeAll()
    expect(disposals).toBe(0)
    expect(Instance.refreshStatus(tmp.path).state).toBe("pending")
    await Instance.provide({
      directory: tmp.path,
      fn: () => AppRuntime.runPromise(ActorExecution.Service.use((svc) => svc.release(execution))),
    })
    await Bun.sleep(20)
    expect(disposals).toBe(1)
  } finally {
    unregister()
  }
})

test("actor acquire waiter retains the old instance across an owner handoff", async () => {
  await using tmp = await tmpdir()
  const { id } = await Instance.provide({
    directory: tmp.path,
    fn: () => AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "actor handoff" }))),
  })
  const ctx = await Instance.provide({ directory: tmp.path, fn: () => Instance.current })
  const owner = await Instance.restore(ctx, () => AppRuntime.runPromise(ActorExecution.Service.use((svc) => svc.reserve(id, "actor-1"))))
  const waiter = Instance.restore(ctx, () => AppRuntime.runPromise(ActorExecution.Service.use((svc) => svc.acquire(id, "actor-1"))))
  await Bun.sleep(10)
  try {
    await Instance.disposeAll()
    await Instance.restore(ctx, () => AppRuntime.runPromise(ActorExecution.Service.use((svc) => svc.release(owner))))
    expect(Instance.refreshStatus(tmp.path).state).toBe("pending")
    const next = await waiter
    expect(next).not.toBe(owner)
    await Instance.restore(ctx, () => AppRuntime.runPromise(ActorExecution.Service.use((svc) => svc.release(next))))
    await Bun.sleep(20)
    expect(Instance.refreshStatus(tmp.path).state).toBe("applied")
  } finally {
    await Instance.restore(ctx, () => AppRuntime.runPromise(ActorExecution.Service.use((svc) => svc.release(owner))))
  }
})

test("execution claims defer refresh across main and actor lifetimes", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({ directory: tmp.path, fn: () => undefined })
  let disposals = 0
  const unregister = registerDisposer(async (directory) => {
    if (directory === tmp.path) disposals++
  })
  const main = Instance.claim(tmp.path)
  const actor = Instance.claim(tmp.path)
  try {
    await Instance.disposeAll()
    await Instance.disposeAll()
    expect(disposals).toBe(0)
    expect(Instance.refreshStatus(tmp.path).state).toBe("pending")
    expect(Instance.refreshStatus().state).toBe("pending")
    main()
    expect(disposals).toBe(0)
    actor()
    actor()
    await Bun.sleep(20)
    expect(disposals).toBe(1)
    expect(Instance.refreshStatus(tmp.path).state).toBe("applied")
    expect(Instance.refreshStatus().state).toBe("applied")
  } finally {
    main()
    actor()
    unregister()
  }
})

test("global config status reports aggregate and per-directory application", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  await Instance.provide({ directory: first.path, fn: () => undefined })
  await Instance.provide({ directory: second.path, fn: () => undefined })
  const release = Instance.claim(second.path)
  try {
    await Instance.disposeAll()
    const app = GlobalRoutes()
    const aggregate = await app.request("/config/status")
    expect(aggregate.status).toBe(200)
    const pending = await aggregate.json()
    expect(pending.state).toBe("pending")
    expect(pending.requested).toBeGreaterThan(pending.applied)
    const firstStatus = await app.request(`/config/status?directory=${encodeURIComponent(first.path)}`)
    expect((await firstStatus.json()).state).toBe("applied")
    release()
    await Bun.sleep(20)
    const applied = await (await app.request("/config/status")).json()
    expect(applied.state).toBe("applied")
    expect(applied.requested).toBe(applied.applied)
  } finally {
    release()
  }
})

test("reload rejects in-flight execution without tearing down its scope", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({ directory: tmp.path, fn: () => undefined })
  const release = Instance.claim(tmp.path)
  let disposals = 0
  const unregister = registerDisposer(async (directory) => {
    if (directory === tmp.path) disposals++
  })
  try {
    await expect(Instance.reload({ directory: tmp.path })).rejects.toThrow("Instance busy")
    expect(disposals).toBe(0)
  } finally {
    release()
    unregister()
  }
})

test("concurrent reload returns Busy without waiting for the first disposer", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({ directory: tmp.path, fn: () => undefined })
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const unregister = registerDisposer(async (directory) => {
    if (directory !== tmp.path) return
    started.resolve()
    await finish.promise
  })
  try {
    const first = Instance.reload({ directory: tmp.path })
    await started.promise
    await expect(Instance.reload({ directory: tmp.path })).rejects.toThrow("Instance busy")
    finish.resolve()
    await first
  } finally {
    finish.resolve()
    unregister()
  }
})

test("a second refresh during cleanup remains pending until the latest generation is applied", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({ directory: tmp.path, fn: () => undefined })
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const unregister = registerDisposer(async (directory) => {
    if (directory !== tmp.path) return
    started.resolve()
    await finish.promise
  })
  try {
    const first = Instance.disposeAll()
    await started.promise
    const initial = Instance.refreshStatus(tmp.path)
    const second = Instance.disposeAll()
    expect(Instance.refreshStatus(tmp.path).requested).toBeGreaterThan(initial.requested)
    expect(Instance.refreshStatus().state).toBe("pending")
    finish.resolve()
    await Promise.all([first, second])
    await Bun.sleep(20)
    const applied = Instance.refreshStatus(tmp.path)
    expect(applied.state).toBe("applied")
    expect(applied.applied).toBe(applied.requested)
  } finally {
    finish.resolve()
    unregister()
  }
})

test("failed cleanup stays pending and a later refresh retries before admission", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({ directory: tmp.path, fn: () => undefined })
  let attempts = 0
  const unregister = registerDisposer(async (directory) => {
    if (directory !== tmp.path) return
    attempts++
    if (attempts === 1) throw new Error("cleanup failed")
  })
  try {
    await Instance.disposeDirectory(tmp.path)
    expect(Instance.refreshStatus(tmp.path).state).toBe("pending")
    await expect(Instance.provide({ directory: tmp.path, fn: () => undefined })).rejects.toThrow("Instance busy")
    await Instance.disposeDirectory(tmp.path)
    expect(attempts).toBe(2)
    expect(Instance.refreshStatus(tmp.path).state).toBe("applied")
  } finally {
    unregister()
  }
})

test("timed-out response keeps directory closed until the disposer finishes", async () => {
  await using tmp = await tmpdir()
  let started!: () => void
  let finish!: () => void
  const disposing = new Promise<void>((resolve) => (started = resolve))
  const blocked = new Promise<void>((resolve) => (finish = resolve))
  const unregister = registerDisposer(async (directory) => {
    if (directory !== tmp.path) return
    started()
    await blocked
  })

  try {
    await Instance.provide({ directory: tmp.path, fn: () => undefined })
    const before = Date.now()
    const dispose = Instance.disposeDirectory(tmp.path)
    await disposing

    let initialized = 0
    const replacement = Instance.provide({
      directory: tmp.path,
      init: () => {
        initialized++
        return Promise.resolve()
      },
      fn: () => undefined,
    })

    await dispose
    expect(Date.now() - before).toBeLessThan(3_000)
    expect(Instance.refreshStatus(tmp.path).state).toBe("pending")
    expect(initialized).toBe(0)
    finish()
    await replacement
    expect(initialized).toBe(1)
    expect(Instance.refreshStatus(tmp.path).state).toBe("applied")
  } finally {
    finish()
    unregister()
    await Instance.disposeDirectory(tmp.path)
  }
}, 5_000)
