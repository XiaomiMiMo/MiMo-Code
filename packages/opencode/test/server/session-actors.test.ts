import { ActorTool } from "../../src/tool/actor"
import { MessageID } from "../../src/session/schema"
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { ActorExecution } from "../../src/actor/execution"
import { ActorRegistry } from "../../src/actor/registry"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionRunState } from "../../src/session/run-state"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Instance.disposeAll())

test("actor list reports runtime execution without rewriting persisted claims or outcomes", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const registry = yield* ActorRegistry.Service
          const executions = yield* ActorExecution.Service
          const runs = yield* SessionRunState.Service
          const session = yield* sessions.create({ title: "actor runtime status" })
          const actorID = "explore-1"
          yield* registry.register({
            sessionID: session.id,
            actorID,
            mode: "subagent",
            agent: "explore",
            description: "Explore example",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* registry.updateStatus(session.id, actorID, { status: "running" })
          const read = Effect.gen(function* () {
            const response = yield* Effect.promise(() =>
              Promise.resolve(
                Server.Default().app.request(`/session/${session.id}/actors?directory=${encodeURIComponent(tmp.path)}`),
              ),
            )
            expect(response.status).toBe(200)
            const actors = yield* Effect.promise(
              () =>
                response.json() as Promise<
                  {
                    actorID: string
                    status: string
                    executionActive: boolean
                    lastOutcome?: string
                  }[]
                >,
            )
            const expected = actors.find((actor) => actor.actorID === actorID)!
            const tool = yield* ActorTool
            const def = yield* tool.init()
            const responseForModel = yield* def.execute(
              { operation: { action: "status", actor_id: actorID } },
              {
                sessionID: session.id,
                messageID: MessageID.ascending(),
                agent: "build",
                abort: new AbortController().signal,
                extra: {},
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )
            expect(JSON.parse(responseForModel.output)).toMatchObject({
              actor_id: actorID,
              status: expected.status,
              executionActive: expected.executionActive,
            })
            return expected
          })
          expect(yield* read).toMatchObject({ status: "idle", executionActive: false })
          expect((yield* registry.get(session.id, actorID))?.status).toBe("running")
          const execution = yield* executions.reserve(session.id, actorID)
          expect(yield* read).toMatchObject({ status: "running", executionActive: true })
          // The executor remains active through terminal hooks, even if a step has
          // already written an idle snapshot. Releasing execution is authoritative.
          yield* registry.updateStatus(session.id, actorID, { status: "idle", lastOutcome: "success" })
          expect(yield* read).toMatchObject({ status: "running", executionActive: true })
          yield* executions.release(execution)
          expect(yield* read).toMatchObject({ status: "idle", executionActive: false, lastOutcome: "success" })
          // Foreground/ordinary loops are owned by SessionRunState, without a
          // background ActorExecution. They must still be reported as running.
          const owned = yield* runs.startOwned(session.id, actorID, Effect.interrupt, Effect.never)
          expect(yield* read).toMatchObject({ status: "running", executionActive: true })
          yield* owned.interruptOwned
          expect(yield* read).toMatchObject({ status: "idle", executionActive: false })
          yield* sessions.remove(session.id)
        }),
      ),
  })
})
