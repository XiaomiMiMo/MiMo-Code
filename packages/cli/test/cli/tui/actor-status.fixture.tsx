/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@mimo-ai/sdk/v2"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"

const directory = "/tmp/example"
const sid = "ses_actor_status"
const actorID = "general-1"
const session = {
  id: sid,
  projectID: "test",
  directory,
  title: "Actor status",
  version: "test",
  time: { created: 1, updated: 1 },
}

export async function mount(snapshot: Record<string, unknown>) {
  let sync!: ReturnType<typeof useSync>
  let handler!: (event: GlobalEvent) => void
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })
  const requests: string[] = []
  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      requests.push(request.method)
      const path = new URL(request.url).pathname
      const body = (() => {
        if (path === "/path")
          return { home: directory, state: directory, config: directory, worktree: directory, directory }
        if (path === "/project/current") return { id: "test" }
        if (path === "/config/providers") return { providers: [], default: {} }
        if (path === "/provider") return { all: [], default: {}, connected: [], authenticated: [] }
        if (path === "/session") return [session]
        if (path === `/session/${sid}`) return session
        if (path.endsWith("/actors"))
          return [
            {
              actorID,
              sessionID: sid,
              mode: "subagent",
              agent: "general",
              description: "Example task",
              time: { created: 1, updated: 1 },
              turnCount: 1,
              ...snapshot,
            },
          ]
        if (
          [
            "/agent",
            "/command",
            "/lsp",
            "/formatter",
            "/experimental/workspace",
            "/experimental/workspace/status",
          ].includes(path) ||
          path.startsWith(`/session/${sid}/`)
        )
          return []
        return {}
      })()
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    },
    { preconnect: fetch.preconnect },
  )

  function Probe() {
    sync = useSync()
    onMount(ready)
    return <text>{sync.data.actor[sid]?.[0]?.status ?? "loading"}</text>
  }
  const app = await testRender(
    () => (
      <SDKProvider
        url="http://test"
        directory={directory}
        fetch={fetcher}
        events={{
          subscribe: async (callback) => {
            handler = callback
            return () => {}
          },
        }}
      >
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
    ),
    { width: 30, height: 3 },
  )
  await mounted
  await sync.session.sync(sid)
  return {
    app,
    requests,
    async status(status: "running" | "idle", lastOutcome?: "success" | "failure" | "cancelled") {
      handler({
        directory,
        payload: {
          type: "actor.status",
          properties: {
            sessionID: sid,
            actorID,
            status,
            lastOutcome,
            turnCount: 1,
            lastTurnTime: 1,
          },
        },
      })
      // SDK batches event dispatches in a 16 ms window.
      await Bun.sleep(20)
      await app.renderOnce()
    },
  }
}
