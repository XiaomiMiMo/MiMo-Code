import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir as osTmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { createOpencodeClient } from "@mimo-ai/sdk/v2/client"
import { Connector, type ConnectorStatus } from "@mimo-ai/connector"
import { FakeConnect } from "../../../connector/test/fake-connect"
import { MemorySecrets } from "../../../connector/test/doubles"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { MimoBackend, type EngineEvents } from "../../src/phone/backend"
import { engineFrom } from "../../src/phone/engine"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

afterEach(() => Instance.disposeAll())

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  while (true) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() >= deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

describe("phone connection end to end", () => {
  test(
    "a paired phone lists, reads and continues a MiMo Code session through Connect",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          yield* Effect.promise(async () => {
            await using project = await tmpdir({
              git: true,
              config: {
                enabled_providers: ["alibaba"],
                provider: { alibaba: { options: { apiKey: "test-key", baseURL: llm.url } } },
                model: "alibaba/qwen-plus",
                small_model: "alibaba/qwen-plus",
                agent: { build: { model: "alibaba/qwen-plus" } },
              },
            })
            const app = Server.Default().app
            const client = createOpencodeClient({
              baseUrl: "http://mimocode.test",
              directory: project.path,
              fetch: Object.assign((request: Request) => app.fetch(request), { preconnect: () => {} }) as typeof fetch,
            })
            const handlers = new Set<(event: GlobalEvent) => void>()
            const bus = (event: GlobalEvent) => {
              if (event.directory === project.path) for (const handler of handlers) handler(event)
            }
            GlobalBus.on("event", bus)
            const events: EngineEvents = {
              on(type, handler) {
                const filtered = (event: GlobalEvent) => {
                  if (event.payload?.type === type) handler(event.payload)
                }
                handlers.add(filtered)
                return () => handlers.delete(filtered)
              },
            }
            const service = new FakeConnect().start()
            const stateDir = await mkdtemp(path.join(osTmpdir(), "phone-e2e-"))
            const backend = new MimoBackend(
              engineFrom(() => client),
              events,
            )
            const statuses: ConnectorStatus[] = []
            const connector = new Connector({
              backend,
              secrets: new MemorySecrets(),
              stateFile: path.join(stateDir, "state"),
              account: async () => ({ ...service.account(), subject: "debug:subject" }),
              client: { version: "1.0.0", platform: "linux" },
              name: "MiMo Code (test)",
              host: { confirmPairing: async () => ({ canSend: true }), status: (status) => statuses.push(status) },
              pairingPollMs: 20,
            })
            try {
              const session = (await client.session.create({ title: "From the phone" }, { throwOnError: true })).data

              // Pair: the code is claimed by a phone and confirmed locally.
              await connector.start()
              await until(
                () => connector.status,
                (status) => status.state === "online",
              )
              const outcome = connector.pair()
              const challenge = await until(
                () => [...service.challenges.values()].find((c) => c.status === "open"),
                (c) => c !== undefined,
              )
              challenge!.status = "claimed"
              challenge!.request = { requestId: crypto.randomUUID(), phoneName: "Pixel" }
              expect(await outcome).toBe("approved")
              await until(
                () => connector.status,
                (status) => status.state === "online" && status.phones.some((phone) => phone.connected),
              )

              const attach = service.frames.findLast(
                (f) => f.path.endsWith("/command") && f.frame.type === "attach",
              )!.frame
              const target = {
                protocolVersion: 4,
                bindingId: attach.bindingId,
                connectionEpoch: attach.connectionEpoch,
                deviceGroupId: attach.deviceGroupId,
                grantVersion: attach.grantVersion,
              }
              const ask = (operation: string, fields: Record<string, unknown> = {}) => {
                const ids = { requestId: crypto.randomUUID(), dispatchId: crypto.randomUUID() }
                service.sendOnLane("command", { ...target, ...ids, type: "request", operation, ...fields })
                return ids
              }
              const answer = (requestId: string, type: string) =>
                until(
                  () => service.frames.find((f) => f.frame.requestId === requestId && f.frame.type === type)?.frame,
                  (frame) => frame !== undefined,
                )
              const frames = (lane: string, requestId: string) =>
                service.frames
                  .filter((f) => f.path.endsWith(`/${lane}`) && f.frame.requestId === requestId)
                  .map((f) => f.frame)

              // The catalog lists the project's session.
              const list = ask("sessions-list", { cursor: null, limit: 50 })
              const page = (await answer(list.requestId, "sessions-page"))!
              expect(
                (page.entries as { sessionId: string; title: string }[]).map((e) => [e.sessionId, e.title]),
              ).toEqual([[session.id, "From the phone"]])

              // Reading starts with a paired snapshot of the empty session.
              const reading = ask("subscribe-session", { sessionId: session.id })
              await until(
                () => frames("state", reading.requestId),
                (state) => state.length === 1,
              )
              expect(frames("text", reading.requestId)[0]).toMatchObject({ sequence: 0, snapshot: true, parts: [] })
              expect(frames("state", reading.requestId)[0]).toMatchObject({ sessionPhase: "idle", turns: [] })

              // Sending continues the session; the reply streams back and the turn completes.
              await Effect.runPromise(llm.text("Hi from MiMo Code"))
              const send = ask("send", { sessionId: session.id, text: "hello from the phone" })
              const result = (await answer(send.requestId, "submission-result"))!
              expect(result).toMatchObject({ status: "accepted", sessionId: session.id })
              const messageId = result.messageId as string

              const finished = await until(
                () => frames("state", reading.requestId).at(-1),
                (state) =>
                  (state?.turns as { phase: string }[] | undefined)?.[0]?.phase === "completed" &&
                  state?.sessionPhase === "idle",
              )
              const turn = (finished!.turns as Record<string, unknown>[])[0]
              expect(turn.inputMessageId).toBe(messageId)
              const texts = frames("text", reading.requestId)
              const final = texts.find((frame) => frame.contentRevision === turn.finalContentRevision)!
              expect((final.parts as Record<string, unknown>[]).map((p) => [p.role, p.text])).toEqual([
                ["user", "hello from the phone"],
                ["assistant", "Hi from MiMo Code"],
              ])
              expect((final.parts as Record<string, unknown>[])[0].messageId).toBe(messageId)
              // Sequences on each lane are gapless and only the first frame is a snapshot.
              for (const lane of ["text", "state"]) {
                frames(lane, reading.requestId).forEach((frame, index) => {
                  expect(frame.sequence).toBe(index)
                  expect(frame.snapshot).toBe(index === 0)
                })
              }

              // The phone's ordering rules: text revisions strictly rise, state never goes back,
              // and no state frame names a text revision that was not published before it.
              const textRevisions = texts.map((frame) => frame.contentRevision as number)
              expect(textRevisions).toEqual([...textRevisions].sort((a, b) => a - b))
              expect(new Set(textRevisions).size).toBe(textRevisions.length)
              const lanes = service.frames.filter(
                (f) =>
                  f.frame.requestId === reading.requestId &&
                  (f.frame.type === "event-text" || f.frame.type === "event-state"),
              )
              let published = 0
              let stateRevision = 0
              for (const { frame } of lanes) {
                if (frame.type === "event-text") published = frame.contentRevision as number
                else {
                  expect(frame.contentRevision as number).toBeGreaterThanOrEqual(stateRevision)
                  expect(frame.contentRevision as number).toBeLessThanOrEqual(published)
                  stateRevision = frame.contentRevision as number
                  for (const t of frame.turns as { finalContentRevision: number | null }[]) {
                    if (t.finalContentRevision !== null) expect(t.finalContentRevision).toBeLessThanOrEqual(published)
                  }
                }
              }

              // Asking about the send again answers from the record without a second prompt.
              service.sendOnLane("command", {
                ...target,
                requestId: send.requestId,
                dispatchId: crypto.randomUUID(),
                type: "request",
                operation: "submission-status",
                sessionId: session.id,
              })
              await until(
                () =>
                  service.frames.filter(
                    (f) => f.frame.requestId === send.requestId && f.frame.type === "submission-result",
                  ),
                (answers) => answers.length === 2,
              )
              expect(await Effect.runPromise(llm.calls)).toBe(1)
            } finally {
              await connector.stop()
              backend.dispose()
              GlobalBus.off("event", bus)
              service.stop()
              await rm(stateDir, { recursive: true, force: true })
            }
          })
        }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
      ),
    60_000,
  )
})
