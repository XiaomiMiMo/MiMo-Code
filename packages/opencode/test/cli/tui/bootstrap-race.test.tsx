/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@mimo-ai/sdk/v2"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { ProjectProvider, useProject } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider, useSDK } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"

// DIR_A stands in for the launch directory, DIR_B for the globally-unique
// Orchestrator workspace the entry effect switches into.
const DIR_A = "/tmp/bootrace-a"
const DIR_B = "/tmp/bootrace-b"

async function wait(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

function sessionRow(id: string, directory: string, updated: number) {
  return {
    id,
    projectID: "p",
    directory,
    title: "t",
    version: "test",
    time: { created: updated, updated },
  }
}

/**
 * HTTP double for the endpoints project/sync touch. It keeps per-directory
 * server-side session state so `POST /session` is observable, can delay a route
 * (so a non-blocking store write lands after an await the caller already
 * returned from), and can park one in-flight request until the test releases it.
 */
function createFetch(input: { sessions?: Record<string, string[]>; delay?: Record<string, number> } = {}) {
  const seen: { method: string; path: string; directory?: string }[] = []
  const sessions: Record<string, string[]> = input.sessions ?? {}
  const delay = input.delay ?? {}
  let held: { path: string; directory: string; parked: boolean; release: () => void } | undefined
  let created = 0

  function body(method: string, path: string, directory?: string): unknown {
    if (path === "/path")
      return { home: "/home", state: "/state", config: "/config", worktree: "", directory: directory ?? "" }
    if (path === "/project/current") return { id: "p" }
    if (path === "/config/providers") return { providers: [], default: {} }
    if (path === "/provider") return { all: [], default: {}, connected: [], authenticated: [] }
    // vcs is a NON-blocking bootstrap write, and its payload identifies the
    // directory that produced it — that is what makes a stale write visible.
    if (path === "/vcs") return { branch: directory === DIR_B ? "branch-b" : "branch-a" }
    if (path === "/session" && method === "POST") {
      created += 1
      const id = `ses_created_${created}`
      sessions[directory ?? ""] = [...(sessions[directory ?? ""] ?? []), id]
      return sessionRow(id, directory ?? "", 1000 + created)
    }
    if (path === "/session")
      return (sessions[directory ?? ""] ?? []).map((id, i) => sessionRow(id, directory ?? "", 100 + i))
    if (path === "/experimental/console") return {}
    if (path === "/agent" || path === "/command" || path === "/experimental/workspace") return []
    if (path === "/experimental/workspace/status" || path === "/lsp" || path === "/formatter") return []
    return {}
  }

  const fetcher = (async (request: Request) => {
    const url = new URL(request.url)
    const raw = url.searchParams.get("directory")
    const directory = raw ? decodeURIComponent(raw) : undefined
    seen.push({ method: request.method, path: url.pathname, directory })

    if (held && url.pathname === held.path && directory === held.directory) {
      const gate = held
      held = undefined
      gate.parked = true
      await new Promise<void>((resolve) => {
        gate.release = resolve
      })
    }

    const ms = delay[url.pathname]
    if (ms) await Bun.sleep(ms)

    return new Response(JSON.stringify(body(request.method, url.pathname, directory)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch

  return {
    fetch: fetcher,
    count(method: string, path: string) {
      return seen.filter((x) => x.method === method && x.path === path).length
    },
    roots(directory: string) {
      return sessions[directory] ?? []
    },
    /** Park the next request for `path` in `directory` until the returned fn is called. */
    hold(path: string, directory: string) {
      const gate = { path, directory, parked: false, release: () => {} }
      held = gate
      return { parked: () => gate.parked, release: () => gate.release() }
    },
  }
}

function createEvents() {
  let fn: ((event: GlobalEvent) => void) | undefined
  return {
    subscribe: async (handler: (event: GlobalEvent) => void) => {
      fn = handler
      return () => {
        if (fn === handler) fn = undefined
      }
    },
  }
}

async function mount(http: ReturnType<typeof createFetch>) {
  let ctx!: {
    project: ReturnType<typeof useProject>
    sdk: ReturnType<typeof useSDK>
    sync: ReturnType<typeof useSync>
  }
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    const project = useProject()
    const sdk = useSDK()
    const sync = useSync()
    onMount(() => {
      ctx = { project, sdk, sync }
      done()
    })
    return <box />
  }

  const app = await testRender(() => (
    <SDKProvider url="http://test" directory={DIR_A} fetch={http.fetch} events={createEvents()}>
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

  await ready
  return { app, ...ctx }
}

describe("tui bootstrap directory race", () => {
  test("a non-blocking bootstrap write that resolves after a directory switch is discarded", async () => {
    const http = createFetch({ sessions: { [DIR_A]: [], [DIR_B]: ["ses_orch"] } })
    const { app, sdk, sync } = await mount(http)

    try {
      await wait(() => sync.data.vcs?.branch === "branch-a")

      // Park the OLD directory's /vcs so the stale run's non-blocking write is
      // still in flight when the switch lands. The request has to be issued
      // before the switch — `sdk.client` is read when the non-blocking group
      // runs, so waiting for the park is what makes this the real window.
      const gate = http.hold("/vcs", DIR_A)
      const staleRun = sync.bootstrap({ fatal: false })
      await wait(() => gate.parked())

      sdk.switchDirectory(DIR_B)
      await sync.bootstrap({ fatal: false })
      await wait(() => sync.data.vcs?.branch === "branch-b")

      gate.release()
      await staleRun
      // bootstrap does not await its own non-blocking group (it is `void
      // Promise.all`), so give the released write every chance to land.
      await Bun.sleep(50)

      // The store must keep describing the directory the client actually talks
      // to. A superseded write here is how pre-switch data gets resurrected.
      expect(sync.data.vcs?.branch).toBe("branch-b")
    } finally {
      app.renderer.destroy()
    }
  })

  test("entering the orchestrator repeatedly resolves the one existing root instead of creating more", async () => {
    // The launch directory has no root sessions, which is what the live repro
    // looked like: the store is empty at the moment the entry effect reads it.
    const http = createFetch({
      sessions: { [DIR_A]: [], [DIR_B]: ["ses_orch"] },
      // The session list is a NON-blocking bootstrap request, so `await
      // bootstrap()` returns before it lands. Delaying it makes that ordering
      // explicit rather than incidental.
      delay: { "/session": 30 },
    })
    const { app, sdk, sync } = await mount(http)

    try {
      const resolved: { id?: string; created: boolean }[] = []
      for (let i = 0; i < 3; i++) {
        // The entry effect's sequence: switch into the orchestrator workspace,
        // bootstrap it, then resolve the root it must land on.
        sdk.switchDirectory(DIR_B)
        await sync.bootstrap({ fatal: false })
        resolved.push(await sync.session.resolveRoot())
        // Leaving orchestrator again, so the next iteration is a real re-entry:
        // wait until the store actually describes the launch directory, which is
        // the state every entry starts from.
        sdk.switchDirectory(DIR_A)
        await sync.bootstrap({ fatal: false })
        await wait(() => sync.data.session.length === 0)
      }

      expect(resolved.map((x) => x.id)).toEqual(["ses_orch", "ses_orch", "ses_orch"])
      expect(resolved.every((x) => x.created === false)).toBe(true)
      expect(http.count("POST", "/session")).toBe(0)
      expect(http.roots(DIR_B)).toEqual(["ses_orch"])
    } finally {
      app.renderer.destroy()
    }
  })
})
