import { afterEach, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Database, eq } from "../../src/storage"
import { InputTable, ActionTable } from "../../src/superagent/superagent.sql"
import { InboxTable } from "../../src/inbox/inbox.sql"
import { PartTable, MessageTable } from "../../src/session/session.sql"
import { Server } from "../../src/server/server"
import * as Runtime from "../../src/superagent/runtime"
import * as D from "../../src/superagent/dispatcher"
import * as View from "../../src/superagent/view"
import { setRuntimeDefaults } from "../../src/config/config"
import { toolCallResponse, textStopResponse } from "../lib/scripted-llm-server"
let model: ReturnType<typeof Bun.serve> | undefined
let directory = ""
afterEach(async () => {
  await Runtime.stop()
  await Instance.disposeAll()
  await model?.stop(true)
  model = undefined
})
const wait = async (fn: () => boolean) => {
  const end = Date.now() + 25000
  while (!fn() && Date.now() < end) await Bun.sleep(40)
  if (!fn())
    throw new Error(
      JSON.stringify({
        messages: Database.use((db) => db.select().from(MessageTable).all()),
        parts: Database.use((db) => db.select().from(PartTable).all()),
        tasks: D.list(directory),
        actions: Database.use((db) => db.select().from(ActionTable).where(eq(ActionTable.directory, directory)).all()),
        inbox: Database.use((db) => db.select().from(InboxTable).all()),
      }),
    )
}

test("user task API runs Router → native Worker → delivery and sends feedback to the same Session", async () => {
  let routerCalls = 0,
    workerCalls = 0
  model = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { messages: { role: string; content: unknown }[] }
      const system = JSON.stringify(body.messages.filter((x) => x.role === "system"))
      let lines: string[]
      if (system.includes("You are the workspace Router")) {
        routerCalls++
        const input = Database.use((db) =>
          db.select().from(InputTable).where(eq(InputTable.event_id, "request-example")).get(),
        )!
        lines = !input.ticket_id
          ? toolCallResponse({
              id: "route-example",
              name: "superagent_route",
              args: JSON.stringify({ action: "create", inputId: input.id, goal: "Write the expected result" }),
            })
          : textStopResponse("Task created. Open its Worker to follow delivery.")
      } else if (system.includes("You own one persistent task")) {
        workerCalls++
        const t = D.list(directory)[0]
        const command = t.revision ? "printf revised > result.txt" : "printf fixed > result.txt"
        lines =
          workerCalls % 2 === 0
            ? toolCallResponse({
                id: `report-${workerCalls}`,
                name: "superagent_report",
                args: JSON.stringify({
                  state: "ready",
                  summary: "Wrote and checked result.txt",
                  humanAction: null,
                  artifacts: ["result.txt"],
                }),
              })
            : toolCallResponse({
                id: `write-${workerCalls}`,
                name: "bash",
                args: JSON.stringify({ command, description: "Write expected artifact" }),
              })
      } else lines = textStopResponse("Example title")
      return new Response(lines.join(""), { headers: { "Content-Type": "text/event-stream" } })
    },
  })
  await using tmp = await tmpdir({
    git: true,
    config: {
      enabled_providers: ["test"],
      model: "test/model",
      small_model: "test/model",
      permission: { "*": "allow" },
      provider: {
        test: {
          npm: "@ai-sdk/openai-compatible",
          name: "Test",
          options: { baseURL: `${model.url.origin}/v1`, apiKey: "test-key" },
          models: {
            model: {
              name: "Test model",
              tool_call: true,
              limit: { context: 100000, output: 8000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
    },
  })
  directory = tmp.path
  const app = Server.Default().app
  const post = (url: string, key: string, body: unknown) =>
    app.request(`${url}?directory=${encodeURIComponent(tmp.path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    })
  const result = await post("/superagent/master/inputs", "request-example", { text: "Write and check result.txt" })
  expect(result.status).toBe(200)
  await wait(() => D.list(tmp.path)[0]?.phase === "completed")
  const t = D.list(tmp.path)[0]
  expect(await Bun.file(`${t.worktree}/result.txt`).text()).toBe("fixed")
  expect(t.workerActorId).toBe("main")
  expect(
    (await post("/superagent/master/inputs", "request-example", { text: "Write and check result.txt" })).status,
  ).toBe(200)
  const before = routerCalls
  await Runtime.stop()
  await Instance.disposeAll()
  setRuntimeDefaults(t.worktree!, {})
  expect(
    (await post(`/superagent/tickets/${t.id}/inputs`, "feedback-example", { text: "Revise result.txt" })).status,
  ).toBe(200)
  await wait(() => D.get(tmp.path, t.id).revision === 1 && D.get(tmp.path, t.id).phase === "completed")
  expect(D.get(tmp.path, t.id).workerSessionId).toBe(t.workerSessionId)
  expect(await Bun.file(`${t.worktree}/result.txt`).text()).toBe("revised")
  expect(routerCalls).toBe(before)
  expect(workerCalls).toBe(4)
  const view = await View.snapshot(tmp.path)
  expect(view.tickets).toHaveLength(1)
  expect(view.agents.filter((a) => a.role === "worker")).toHaveLength(1)
  expect(
    Database.use((db) => db.select().from(MessageTable).all()).filter(
      (m) => m.session_id === t.workerSessionId && m.data.role === "user",
    ),
  ).toHaveLength(2)
}, 60000)
