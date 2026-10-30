/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Session } from "@mimo-ai/sdk/v2"
import { createEffect, onMount } from "solid-js"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { ProjectProvider, useProject } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider, useSDK } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"

const SESSION = "ses_example"
const A = "/tmp/example-a"
const B = "/tmp/example-b"

async function wait(check: () => boolean) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("timed out waiting for cost sync")
    await Bun.sleep(5)
  }
}

function gate() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function mount() {
  const costs = new Map([
    [A, 1],
    [B, 20],
  ])
  const calls: string[] = []
  const holds: { directory: string; gate: ReturnType<typeof gate> }[] = []
  let status = 200
  let denied: string | undefined
  const row: Session = {
    id: SESSION,
    projectID: "test",
    directory: A,
    slug: "example",
    title: "Example",
    titleSource: "user",
    titleRevision: 0,
    version: "test",
    time: { created: 1, updated: 1 },
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const directory = url.searchParams.get("directory") ?? A
      const workspace = url.searchParams.get("workspace")
      const key = workspace ? `${directory}:${workspace}` : directory
      const path = url.pathname
      const json = (value: unknown, code = 200) => Response.json(value, { status: code })
      if (path === `/session/${SESSION}/cost`) {
        calls.push(key)
        const cost = costs.get(key) ?? 0
        const code = status
        const index = holds.findIndex((h) => h.directory === key)
        if (index >= 0) await holds.splice(index, 1)[0].gate.promise
        return json(code === 200 ? { cost } : { message: "Cost unavailable" }, code)
      }
      if (path === "/path")
        return json({
          home: "/tmp/example",
          state: "/tmp/example/state",
          config: "/tmp/example/config",
          worktree: "",
          directory,
        })
      if (path === "/project/current") return json({ id: "test" })
      if (directory === denied && path === "/config/providers") return json({ message: "Directory denied" }, 403)
      if (path === "/config/providers") return json({ providers: [], default: {} })
      if (path === "/provider") return json({ all: [], default: {}, connected: [], authenticated: [] })
      if (path === "/session") return json([row])
      if (path === `/session/${SESSION}`) return json(row)
      if (path.startsWith(`/session/${SESSION}/`)) return json([])
      if (path === "/experimental/workspace") return json([{ id: "wrk_example-a" }, { id: "wrk_example-b" }])
      if (
        [
          "/agent",
          "/command",
          "/lsp",
          "/formatter",
          "/experimental/workspace",
          "/experimental/workspace/status",
        ].includes(path)
      )
        return json([])
      if (path === "/vcs") return json({ branch: "feat/example" })
      return json({})
    },
  })
  let ctx!: { sdk: ReturnType<typeof useSDK>; sync: ReturnType<typeof useSync>; project: ReturnType<typeof useProject> }
  const seen: (number | undefined)[] = []
  const ready = gate()
  function Probe() {
    const sdk = useSDK()
    const sync = useSync()
    const project = useProject()
    createEffect(() => seen.push(sync.data.session_cost?.[SESSION]))
    onMount(() => {
      ctx = { sdk, sync, project }
      ready.release()
    })
    return <box />
  }
  const app = await testRender(() => (
    <SDKProvider url={server.url.toString()} directory={A} events={{ subscribe: async () => () => {} }}>
      <ProjectProvider>
        <ArgsProvider>
          <ExitProvider>
            <SyncProvider>
              <Probe />
            </SyncProvider>
          </ExitProvider>
        </ArgsProvider>
      </ProjectProvider>
    </SDKProvider>
  ))
  await ready.promise
  await wait(() => ctx.project.instance.directory() === A)
  let destroyed = false
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    app.renderer.destroy()
  }
  return {
    ...ctx,
    calls,
    costs,
    seen,
    destroy,
    deny: (directory: string) => {
      denied = directory
    },
    cost: () => ctx.sync.data.session_cost?.[SESSION],
    status: (code: number) => {
      status = code
    },
    hold(directory = A) {
      const held = gate()
      holds.push({ directory, gate: held })
      return held.release
    },
    changed() {
      ctx.sdk.event.emit("event", {
        directory: ctx.sdk.directory ?? A,
        workspace: ctx.project.workspace.current(),
        payload: {
          type: "message.updated",
          properties: {
            sessionID: SESSION,
            info: {
              id: "msg_example",
              sessionID: SESSION,
              agentID: "general-1",
              role: "assistant",
              parentID: "msg_parent",
              agent: "general",
              mode: "default",
              providerID: "test",
              modelID: "model",
              path: { cwd: "/tmp/example", root: "/tmp/example" },
              cost: 2,
              tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, completed: 2 },
            },
          },
        },
      })
    },
    removed() {
      ctx.sdk.event.emit("event", {
        directory: ctx.sdk.directory ?? A,
        workspace: ctx.project.workspace.current(),
        payload: { type: "message.removed", properties: { sessionID: SESSION, messageID: "msg_evicted" } },
      })
    },
    connected() {
      // The global SSE endpoint sends this without the generated required directory.
      // @ts-expect-error Exercise the actual wire shape from streamEvents.
      ctx.sdk.event.emit("event", { payload: { type: "server.connected", properties: {} } })
    },
    deleted() {
      ctx.sdk.event.emit("event", {
        directory: ctx.sdk.directory ?? A,
        workspace: ctx.project.workspace.current(),
        payload: { type: "session.deleted", properties: { sessionID: SESSION, info: row } },
      })
    },
    close() {
      destroy()
      for (const held of holds) held.gate.release()
      void server.stop(true)
    },
  }
}

test("loads total cost and refreshes underagent updates and evicted message removals", async () => {
  const h = await mount()
  try {
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 1)
    h.costs.set(A, 3)
    h.changed()
    await wait(() => h.cost() === 3)
    h.costs.set(A, 3.5)
    h.changed()
    await wait(() => h.cost() === 3.5)
    h.costs.set(A, 2)
    h.removed()
    await wait(() => h.cost() === 2)
  } finally {
    h.close()
  }
})

test("coalesces overlapping invalidations and rejects the superseded response", async () => {
  const h = await mount()
  try {
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 1)
    const release = h.hold()
    h.costs.set(A, 3)
    h.changed()
    await wait(() => h.calls.length === 2)
    h.costs.set(A, 6)
    h.changed()
    h.changed()
    h.removed()
    expect(h.calls).toHaveLength(2)
    release()
    await wait(() => h.cost() === 6)
    expect(h.calls).toHaveLength(3)
    expect(h.seen).not.toContain(3)
  } finally {
    h.close()
  }
})

test("re-entry, bootstrap and directory-less reconnect refresh only opened sessions", async () => {
  const h = await mount()
  try {
    h.connected()
    expect(h.calls).toHaveLength(0)
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 1)
    h.costs.set(A, 2)
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 2)
    h.costs.set(A, 3)
    await h.sync.bootstrap({ fatal: false })
    await wait(() => h.cost() === 3)
    h.costs.set(A, 4)
    h.connected()
    await wait(() => h.cost() === 4)
  } finally {
    h.close()
  }
})

test("missing endpoints do not block opening, transient errors retain the confirmed cost", async () => {
  const h = await mount()
  try {
    h.status(404)
    await h.sync.session.sync(SESSION)
    await wait(() => h.calls.length === 1)
    expect(h.cost()).toBeUndefined()
    h.status(200)
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 1)
    h.status(500)
    h.changed()
    await wait(() => h.calls.length === 3)
    expect(h.cost()).toBe(1)
    h.status(200)
    h.costs.set(A, 0)
    h.connected()
    await wait(() => h.cost() === 0)
  } finally {
    h.close()
  }
})

test("late responses after deletion cannot restore cost", async () => {
  const h = await mount()
  try {
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 1)
    const release = h.hold()
    h.costs.set(A, 2)
    h.changed()
    await wait(() => h.calls.length === 2)
    h.deleted()
    release()
    await Bun.sleep(25)
    expect(h.cost()).toBeUndefined()
    h.connected()
    expect(h.calls).toHaveLength(2)
  } finally {
    h.close()
  }
})

test("disposal removes the reconnect listener and ignores an in-flight response", async () => {
  const h = await mount()
  try {
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 1)
    const release = h.hold()
    h.costs.set(A, 2)
    h.changed()
    await wait(() => h.calls.length === 2)
    h.destroy()
    release()
    await Bun.sleep(25)
    h.connected()
    expect(h.cost()).toBe(1)
    expect(h.calls).toHaveLength(2)
  } finally {
    h.close()
  }
})

test("workspace switches use the selected workspace and discard prior reads", async () => {
  const h = await mount()
  try {
    const first = `${A}:wrk_example-a`
    const second = `${A}:wrk_example-b`
    h.costs.set(first, 10)
    h.costs.set(second, 20)
    h.project.workspace.set("wrk_example-a")
    await h.sync.bootstrap({ fatal: false })
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 10)
    const release = h.hold(first)
    h.costs.set(first, 15)
    h.changed()
    await wait(() => h.calls.length === 2)
    h.project.workspace.set("wrk_example-b")
    await h.sync.bootstrap({ fatal: false })
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 20)
    release()
    await Bun.sleep(25)
    expect(h.cost()).toBe(20)
    expect(h.calls).toEqual([first, first, second])
    expect(h.seen).not.toContain(15)
  } finally {
    h.close()
  }
})

test("A to B to A does not let an old request clear or overwrite the new request", async () => {
  const h = await mount()
  try {
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 1)
    const oldA = h.hold(A)
    h.costs.set(A, 2)
    h.changed()
    await wait(() => h.calls.length === 2)
    h.sdk.switchDirectory(B)
    await h.sync.bootstrap({ fatal: false })
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 20)
    h.sdk.switchDirectory(A)
    const newA = h.hold(A)
    h.costs.set(A, 5)
    await h.sync.bootstrap({ fatal: false })
    await h.sync.session.sync(SESSION)
    await wait(() => h.calls.length === 4)
    oldA()
    await Bun.sleep(25)
    h.costs.set(A, 6)
    h.changed()
    expect(h.calls).toHaveLength(4)
    newA()
    await wait(() => h.cost() === 6)
    expect(h.calls).toHaveLength(5)
    expect(h.seen).not.toContain(2)
    expect(h.seen).not.toContain(5)
  } finally {
    h.close()
  }
})

test("a failed directory switch restores tracking without session re-entry", async () => {
  const h = await mount()
  try {
    await h.sync.session.sync(SESSION)
    await wait(() => h.cost() === 1)
    h.deny(B)
    h.sdk.switchDirectory(B)
    const failure = await h.sync.bootstrap({ fatal: false }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeDefined()
    h.costs.set(A, 4)
    h.sdk.switchDirectory(A)
    await h.sync.bootstrap({ fatal: false })
    await wait(() => h.cost() === 4)
    h.costs.set(A, 5)
    h.changed()
    await wait(() => h.cost() === 5)
    h.costs.set(A, 6)
    h.connected()
    await wait(() => h.cost() === 6)
  } finally {
    h.close()
  }
})
