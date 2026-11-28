/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { GlobalEvent, QuestionRequest } from "@mimo-ai/sdk/v2"
import { createEffect, onMount } from "solid-js"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { ProjectProvider, useProject } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider, useSDK } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"

export const directoryA = "/tmp/example-a"
export const directoryB = "/tmp/example-b"

export async function waitFor(predicate: () => boolean, label = "question state") {
  const until = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

export function question(id: string, sessionID = "ses_example"): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [{ question: "Choose?", header: "Example", options: [{ label: "Yes", description: "Continue" }] }],
  }
}

export async function mountQuestions(initial: QuestionRequest[] = []) {
  const snapshots = new Map<string, QuestionRequest[]>([[directoryA, initial]])
  const reads: { directory: string; status: number; completed: boolean }[] = []
  const history: string[][] = []
  let held: { directory: string; started: boolean; release: () => void } | undefined
  let nextStatus = 200
  let handler!: (event: GlobalEvent) => void
  let sync!: ReturnType<typeof useSync>
  let sdk!: ReturnType<typeof useSDK>
  let project!: ReturnType<typeof useProject>
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })

  const fetcher = Object.assign(
    async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const directory = decodeURIComponent(url.searchParams.get("directory") ?? directoryA)
      const route = url.pathname
      if (route === "/question") {
        const row = { directory, status: nextStatus, completed: false }
        nextStatus = 200
        reads.push(row)
        const snapshot = [...(snapshots.get(directory) ?? [])]
        if (held?.directory === directory) {
          const gate = held
          held = undefined
          gate.started = true
          await new Promise<void>((resolve) => {
            gate.release = resolve
          })
        }
        row.completed = true
        return row.status === 200
          ? Response.json(snapshot)
          : Response.json({ name: "Error", data: { message: "Unavailable" } }, { status: row.status })
      }
      if (route === "/path")
        return Response.json({
          home: "/tmp/example",
          state: "/tmp/example",
          config: "/tmp/example",
          worktree: "",
          directory,
        })
      if (route === "/project/current") return Response.json({ id: "example" })
      if (route === "/config/providers") return Response.json({ providers: [], default: {} })
      if (route === "/provider") return Response.json({ all: [], default: {}, connected: [], authenticated: [] })
      if (
        [
          "/session",
          "/agent",
          "/command",
          "/lsp",
          "/formatter",
          "/experimental/workspace",
          "/experimental/workspace/status",
        ].includes(route)
      )
        return Response.json([])
      return Response.json({})
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch

  function Probe() {
    sync = useSync()
    sdk = useSDK()
    project = useProject()
    createEffect(() => {
      history.push(
        Object.values(sync.data.question)
          .flat()
          .map((q) => q.id)
          .sort(),
      )
    })
    onMount(mounted)
    return (
      <text>
        {Object.values(sync.data.question)
          .flat()
          .map((q) => q.id)
          .join(",")}
      </text>
    )
  }

  const app = await testRender(
    () => (
      <SDKProvider
        url="http://example.test"
        directory={directoryA}
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
    { width: 60, height: 3 },
  )
  await ready
  await waitFor(() => sync.status === "complete", "bootstrap")

  async function emit(payload: GlobalEvent["payload"], directory?: string) {
    // Real server.connected packets omit directory despite the generated SDK type.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const event = { ...(directory === undefined ? {} : { directory }), payload } as GlobalEvent
    await new Promise<void>((resolve) => {
      const off = sdk.event.on("event", (incoming) => {
        if (incoming !== event) return
        off()
        resolve()
      })
      handler(event)
    })
  }

  return {
    app,
    sync,
    sdk,
    project,
    reads,
    history,
    ids: () =>
      Object.values(sync.data.question)
        .flat()
        .map((q) => q.id)
        .sort(),
    setSnapshot(questions: QuestionRequest[], directory = directoryA) {
      snapshots.set(directory, questions)
    },
    failNextRead(status = 503) {
      nextStatus = status
    },
    holdNextRead(directory = directoryA) {
      const gate = { directory, started: false, release: () => {} }
      held = gate
      return gate
    },
    connected: () => emit({ type: "server.connected", properties: {} }),
    asked: (request: QuestionRequest, directory = directoryA) =>
      emit({ type: "question.asked", properties: request }, directory),
    rejected: (request: QuestionRequest, directory = directoryA) =>
      emit(
        { type: "question.rejected", properties: { sessionID: request.sessionID, requestID: request.id } },
        directory,
      ),
  }
}
