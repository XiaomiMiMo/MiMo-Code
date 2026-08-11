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

const DIR_A = "/tmp/blanktx-a"
const DIR_B = "/tmp/blanktx-b"

async function wait(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

function sessionRow() {
  return {
    id: "ses_a",
    projectID: "p",
    directory: DIR_A,
    title: "t",
    version: "test",
    time: { created: 1, updated: 1 },
  }
}

/**
 * HTTP double for the endpoints the project/sync contexts touch. Records the
 * directory the client sent with each request, and can hold one `/path` response
 * open so a test can make an in-flight bootstrap resolve AFTER a directory switch.
 */
function createFetch() {
  const seen: { path: string; directory?: string }[] = []
  let held: { directory: string; release: () => void } | undefined

  function body(path: string, directory?: string): unknown {
    if (path === "/path")
      return { home: "/home", state: "/state", config: "/config", worktree: "", directory: directory ?? "" }
    if (path === "/project/current") return { id: "p" }
    if (path === "/config/providers") return { providers: [], default: {} }
    if (path === "/provider") return { all: [], default: {}, connected: [], authenticated: [] }
    if (path === "/session") return [sessionRow()]
    if (path === "/vcs") return { branch: "main" }
    if (path === "/experimental/console") return {}
    if (path.startsWith("/session/ses_a")) return path === "/session/ses_a" ? sessionRow() : []
    if (path === "/agent" || path === "/command" || path === "/experimental/workspace") return []
    if (path === "/experimental/workspace/status" || path === "/lsp" || path === "/formatter") return []
    return {}
  }

  const fetcher = (async (request: Request) => {
    const url = new URL(request.url)
    const raw = url.searchParams.get("directory")
    const directory = raw ? decodeURIComponent(raw) : undefined
    seen.push({ path: url.pathname, directory })

    if (held && url.pathname === "/path" && directory === held.directory) {
      const gate = held
      held = undefined
      await new Promise<void>((resolve) => {
        gate.release = resolve
      })
    }

    return new Response(JSON.stringify(body(url.pathname, directory)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch

  return {
    fetch: fetcher,
    count(path: string) {
      return seen.filter((x) => x.path === path).length
    },
    hold(directory: string) {
      const gate = { directory, release: () => {} }
      held = gate
      return () => gate.release()
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

async function mount() {
  const http = createFetch()
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
  return { app, http, ...ctx }
}

describe("tui directory switch", () => {
  test("a bootstrap started before the switch cannot rewrite instance.path to the old directory", async () => {
    const { app, http, project, sdk, sync } = await mount()

    try {
      await wait(() => project.instance.directory() === DIR_A)

      // Reproduces the app's switch sequence: dispose fires
      // server.instance.disposed, whose handler bootstraps against the OLD
      // directory; the client then switches and bootstraps the new one. The
      // stale run resolves LAST.
      const release = http.hold(DIR_A)
      const staleRun = sync.bootstrap({ fatal: false })
      sdk.switchDirectory(DIR_B)
      await sync.bootstrap({ fatal: false })
      expect(project.instance.directory()).toBe(DIR_B)

      release()
      await staleRun

      // instance.path must keep describing the directory the client actually
      // talks to: useEvent filters every live event on instance.directory(), so
      // a stale value silently drops the whole transcript.
      expect(project.instance.directory()).toBe(DIR_B)
    } finally {
      app.renderer.destroy()
    }
  })

  test("a session is re-syncable after a directory switch and still short-circuits without one", async () => {
    const { app, http, sdk, sync } = await mount()

    try {
      await sync.session.sync("ses_a")
      expect(http.count("/session/ses_a/message")).toBe(1)

      // Invariant that fullSyncedSessions exists for: navigating back to an
      // already-synced session must not refetch its transcript...
      await sync.session.sync("ses_a")
      expect(http.count("/session/ses_a/message")).toBe(1)

      // ...and a bootstrap that stays in the same directory keeps that cache.
      await sync.bootstrap({ fatal: false })
      await sync.session.sync("ses_a")
      expect(http.count("/session/ses_a/message")).toBe(1)

      // A directory switch changes the data source, so the cache must be
      // dropped — otherwise a session synced before the switch can never be
      // re-synced and anything missed stays invisible for the whole session.
      sdk.switchDirectory(DIR_B)
      await sync.bootstrap({ fatal: false })
      await sync.session.sync("ses_a")
      expect(http.count("/session/ses_a/message")).toBe(2)
    } finally {
      app.renderer.destroy()
    }
  })
})
