// @ts-nocheck — diagnostic case runner; fixture messages use loose casts.
/**
 * Subagent resume-recovery case matrix (engine-side).
 * [TP-RUN-R12-32] [TP-RUN-R12-33] [TP-RUN-R12-34]
 *
 * Covers which actors are normal exits vs resume candidates vs live-skip,
 * plus send-continue. Run from packages/opencode:
 *   bun run script/subagent-resume-cases.ts
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import assert from "node:assert/strict"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-resume-cases-"))
const env = {
  HOME: path.join(root, "home"),
  USERPROFILE: path.join(root, "home"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
  MIMOCODE_DB: path.join(root, "cases.db"),
  MIMOCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
  MIMOCODE_MODELS_PATH: path.resolve(import.meta.dir, "../test/tool/fixtures/models-api.json"),
  MIMOCODE_DISABLE_DEFAULT_PLUGINS: "true",
  MIMOCODE_EXPERIMENTAL_ORCHESTRATOR: "true",
}
Object.assign(process.env, env)
delete process.env.MIMOCODE_HOME
await fs.mkdir(env.HOME, { recursive: true })
console.log(">> env ready", env.HOME)

const { Effect, Deferred } = await import("effect")
const { Instance } = await import("../src/project/instance")
const { Session } = await import("../src/session")
const { SessionPrompt } = await import("../src/session/prompt")
const { ActorRegistry } = await import("../src/actor/registry")
const { Actor } = await import("../src/actor/spawn")
const { ActorWaiter } = await import("../src/actor/waiter")
const { Inbox } = await import("../src/inbox")
const { AppLayer } = await import("../src/effect/app-runtime")
const { attach } = await import("../src/effect/run-service")
const { initProjectors } = await import("../src/server/projectors")
const { ProviderID, ModelID } = await import("../src/provider/schema")
const { MessageID, PartID } = await import("../src/session/schema")
const { startScriptedLLMServer, textStopResponse } = await import("../test/lib/scripted-llm-server")
const { Log } = await import("../src/util")

void Log.init({ print: false })
initProjectors()
console.log(">> projectors ready")

const modelRef = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }

type CaseResult = {
  id: string
  title: string
  expect: string
  actual: string
  pass: boolean
  detail?: string
}

const results: CaseResult[] = []

function record(r: CaseResult) {
  results.push(r)
  const mark = r.pass ? "PASS" : "FAIL"
  console.log(`[${mark}] ${r.id} ${r.title}`)
  console.log(`       expect=${r.expect}`)
  console.log(`       actual=${r.actual}`)
  if (r.detail) console.log(`       detail=${r.detail}`)
}

function incompleteAssistant(input: {
  sessionID: string
  parentID: string
  agentID?: string
  agent?: string
  error?: unknown
}) {
  return {
    id: MessageID.ascending(),
    role: "assistant" as const,
    parentID: input.parentID,
    sessionID: input.sessionID,
    ...(input.agentID !== undefined ? { agentID: input.agentID } : {}),
    mode: "build",
    agent: input.agent ?? "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: modelRef.modelID,
    providerID: modelRef.providerID,
    time: { created: Date.now() },
    ...(input.error !== undefined ? { error: input.error } : {}),
  }
}

function completedAssistant(input: {
  sessionID: string
  parentID: string
  agentID?: string
  finish: "stop" | "tool-calls" | "length"
  error?: unknown
}) {
  const base = incompleteAssistant(input)
  return {
    ...base,
    finish: input.finish,
    time: { created: Date.now(), completed: Date.now() },
  }
}

const directory = path.join(root, "project")
await fs.mkdir(directory, { recursive: true })
const server = startScriptedLLMServer([
  // first response is for send-continue (before cascade starts real resumes)
  { lines: textStopResponse("CONTINUED-AFTER-SEND") },
  // cascade may start up to 3 resume turns
  { lines: textStopResponse("CASCADE-RESUME-OK") },
  { lines: textStopResponse("CASCADE-RESUME-OK") },
  { lines: textStopResponse("CASCADE-RESUME-OK") },
  // extra slack for any extra probes
  { lines: textStopResponse("EXTRA") },
  { lines: textStopResponse("EXTRA") },
])
const hook = path.join(directory, "noop-hook.ts")
await fs.writeFile(hook, `export default async () => ({})`)
await fs.writeFile(
  path.join(directory, "mimocode.json"),
  JSON.stringify(
    {
      plugin: [pathToFileURL(hook).href],
      enabled_providers: ["alibaba"],
      provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${server.origin}/v1` } } },
      agent: { custom: { model: "alibaba/qwen-plus", permission: { "*": "deny" } } },
    },
    null,
    2,
  ),
)

const outcome = await Instance.provide({
  directory,
  fn: () =>
    Effect.runPromise(
      attach(
        Effect.gen(function* () {
          console.log(">> instance ready")
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const reg = yield* ActorRegistry.Service
          const inbox = yield* Inbox.Service
          const actor = yield* Actor.Service

          const parent = yield* sessions.create({ title: "subagent resume cases" })
          console.log(">> session", parent.id)

          // Seed a main incomplete turn so main also has a recovery candidate
          // (cascade must NOT resume main itself).
          const mainUser = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: parent.id,
            agent: "build",
            model: modelRef,
            time: { created: Date.now() },
          } as never)
          yield* sessions.updateMessage(
            incompleteAssistant({ sessionID: parent.id, parentID: mainUser.id }) as never,
          )

          // --- S1 normal success idle ---
          yield* reg.register({
            sessionID: parent.id,
            actorID: "explore-success",
            mode: "subagent",
            agent: "explore",
            description: "normal exit",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* reg.updateStatus(parent.id, "explore-success", { status: "idle", lastOutcome: "success" })

          // --- S2 cancelled ---
          yield* reg.register({
            sessionID: parent.id,
            actorID: "general-cancelled",
            mode: "subagent",
            agent: "general",
            description: "cancelled",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* reg.updateStatus(parent.id, "general-cancelled", {
            status: "idle",
            lastOutcome: "cancelled",
          })

          // --- S3 incomplete zombie (no completed) → resume candidate ---
          yield* reg.register({
            sessionID: parent.id,
            actorID: "explore-zombie",
            mode: "subagent",
            agent: "explore",
            description: "crash zombie",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* reg.updateStatus(parent.id, "explore-zombie", {
            status: "idle",
            lastOutcome: "failure",
            lastError:
              'Process restarted while actor was active; settled by abandon threshold. Not final — actor send "continue" can recover.',
          })
          const zUser = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: parent.id,
            agentID: "explore-zombie",
            agent: "explore",
            model: modelRef,
            time: { created: Date.now() },
          } as never)
          yield* sessions.updateMessage(
            incompleteAssistant({
              sessionID: parent.id,
              parentID: zUser.id,
              agentID: "explore-zombie",
              agent: "explore",
            }) as never,
          )

          // --- S4 error-marked assistant → resume candidate ---
          yield* reg.register({
            sessionID: parent.id,
            actorID: "explore-error",
            mode: "subagent",
            agent: "explore",
            description: "error turn",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* reg.updateStatus(parent.id, "explore-error", {
            status: "idle",
            lastOutcome: "failure",
            lastError: "provider boom",
          })
          const eUser = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: parent.id,
            agentID: "explore-error",
            agent: "explore",
            model: modelRef,
            time: { created: Date.now() },
          } as never)
          yield* sessions.updateMessage(
            completedAssistant({
              sessionID: parent.id,
              parentID: eUser.id,
              agentID: "explore-error",
              finish: "stop",
              error: { name: "APIError", data: { message: "provider boom" } },
            }) as never,
          )

          // --- S5 live running → skip ---
          yield* reg.register({
            sessionID: parent.id,
            actorID: "general-live",
            mode: "subagent",
            agent: "general",
            description: "still live",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* reg.updateStatus(parent.id, "general-live", { status: "running" })

          // --- S6 completed+tool-calls (incomplete turn) → candidate ---
          yield* reg.register({
            sessionID: parent.id,
            actorID: "explore-toolcalls",
            mode: "subagent",
            agent: "explore",
            description: "tool-calls unfinished",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* reg.updateStatus(parent.id, "explore-toolcalls", { status: "idle", lastOutcome: "failure" })
          const tUser = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: parent.id,
            agentID: "explore-toolcalls",
            agent: "explore",
            model: modelRef,
            time: { created: Date.now() },
          } as never)
          yield* sessions.updateMessage(
            completedAssistant({
              sessionID: parent.id,
              parentID: tUser.id,
              agentID: "explore-toolcalls",
              finish: "tool-calls",
            }) as never,
          )

          // Recovery predicates
          const recMain = yield* prompt.recovery({ sessionID: parent.id, agentID: "main", allowBusy: true })
          const recZombie = yield* prompt.recovery({
            sessionID: parent.id,
            agentID: "explore-zombie",
            allowBusy: true,
          })
          const recError = yield* prompt.recovery({
            sessionID: parent.id,
            agentID: "explore-error",
            allowBusy: true,
          })
          const recTool = yield* prompt.recovery({
            sessionID: parent.id,
            agentID: "explore-toolcalls",
            allowBusy: true,
          })
          const recSuccess = yield* prompt.recovery({
            sessionID: parent.id,
            agentID: "explore-success",
            allowBusy: true,
          })
          const recCancelled = yield* prompt.recovery({
            sessionID: parent.id,
            agentID: "general-cancelled",
            allowBusy: true,
          })
          const recLive = yield* prompt.recovery({
            sessionID: parent.id,
            agentID: "general-live",
            allowBusy: true,
          })

          record({
            id: "S1",
            title: "normal success idle → no recovery candidate",
            expect: "candidates=0",
            actual: `candidates=${recSuccess.length}`,
            pass: recSuccess.length === 0,
          })
          record({
            id: "S2",
            title: "cancelled idle → no recovery candidate",
            expect: "candidates=0",
            actual: `candidates=${recCancelled.length}`,
            pass: recCancelled.length === 0,
          })
          record({
            id: "S3",
            title: "incomplete zombie → recovery candidate",
            expect: "candidates>=1",
            actual: `candidates=${recZombie.length}`,
            pass: recZombie.length >= 1,
          })
          record({
            id: "S4",
            title: "error-marked assistant → recovery candidate",
            expect: "candidates>=1",
            actual: `candidates=${recError.length}`,
            pass: recError.length >= 1,
          })
          record({
            id: "S5",
            title: "live running actor has no incomplete last assistant",
            expect: "candidates=0",
            actual: `candidates=${recLive.length}`,
            pass: recLive.length === 0,
          })
          record({
            id: "S6",
            title: "completed+tool-calls → recovery candidate",
            expect: "candidates>=1",
            actual: `candidates=${recTool.length}`,
            pass: recTool.length >= 1,
          })
          record({
            id: "S7",
            title: "main also has incomplete assistant (cascade must not target main)",
            expect: "candidates>=1",
            actual: `candidates=${recMain.length}`,
            pass: recMain.length >= 1,
          })

          // --- S8 send continue FIRST (before cascade starts real resume turns) ---
          yield* reg.register({
            sessionID: parent.id,
            actorID: "custom-continue",
            mode: "subagent",
            agent: "custom",
            description: "send continue target",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
          })
          yield* reg.updateStatus(parent.id, "custom-continue", {
            status: "idle",
            lastOutcome: "failure",
            lastError: "abandoned",
          })
          const cUser = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: parent.id,
            agentID: "custom-continue",
            agent: "custom",
            model: modelRef,
            time: { created: Date.now() },
          } as never)
          const incomplete = yield* sessions.updateMessage(
            incompleteAssistant({
              sessionID: parent.id,
              parentID: cUser.id,
              agentID: "custom-continue",
              agent: "custom",
            }) as never,
          )
          // Non-empty residue: abandonRecoveredAssistant skips empty shells.
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: incomplete.id,
            sessionID: parent.id,
            type: "text",
            text: "mid-crash partial",
          } as never)
          const preContinue = yield* prompt.recovery({
            sessionID: parent.id,
            agentID: "custom-continue",
            allowBusy: true,
          })
          console.log(">> pre-continue recovery", preContinue.length, "incomplete", incomplete.id)

          console.log(">> send continue start")
          yield* inbox.send({
            receiverSessionID: parent.id,
            receiverActorID: "custom-continue",
            senderSessionID: parent.id,
            senderActorID: "main",
            content: "continue",
          })
          // Rely on Inbox.send's wake fork — do not call loop manually.

          let abandoned = false
          let continued = false
          for (let i = 0; i < 80; i++) {
            const msgs = yield* sessions.messages({ sessionID: parent.id, agentID: "custom-continue" })
            abandoned = msgs.some((m: { info: { id: string; error?: unknown } }) => {
              if (m.info.id !== incomplete.id) return false
              const err = m.info.error as { data?: { message?: string }; message?: string } | undefined
              const text = err?.data?.message ?? err?.message ?? ""
              return text.includes("Abandoned")
            })
            continued = msgs.some((m: { parts: Array<{ type: string; text?: string }> }) =>
              m.parts.some((p) => p.type === "text" && (p.text ?? "").includes("CONTINUED-AFTER-SEND")),
            )
            if (continued) break
            yield* Effect.sleep("50 millis")
          }
          console.log(">> send continue done", { abandoned, continued })
          {
            const msgs = yield* sessions.messages({ sessionID: parent.id, agentID: "custom-continue" })
            console.log(
              ">> custom-continue msgs",
              msgs.map((m: { info: { id: string; role: string }; parts: Array<{ type: string; text?: string }> }) => ({
                id: m.info.id,
                role: m.info.role,
                parts: m.parts.map((p) => ({ type: p.type, text: (p.text ?? "").slice(0, 80) })),
              })),
            )
          }
          const msgsAfter = (yield* sessions.messages({
            sessionID: parent.id,
            agentID: "custom-continue",
          })) as Array<{ info: { id: string; role: string }; parts: Array<{ type: string; text?: string }> }>
          const continueUser = msgsAfter.some(
            (m) =>
              m.info.role === "user" &&
              m.parts.some((p) => p.type === "text" && (p.text ?? "").includes("continue")),
          )
          const assistantAfter = msgsAfter.some((m, i) => {
            if (m.info.role !== "assistant") return false
            return msgsAfter
              .slice(0, i)
              .some((p) => p.parts.some((part) => part.type === "text" && (part.text ?? "").includes("continue")))
          })
          record({
            id: "S8",
            title: "send continue drains continue user and runs new turn (no abandon required)",
            expect: "continueUser + assistantAfter",
            actual: `continueUser=${continueUser} assistantAfter=${assistantAfter} text=${continued} abandonedStamp=${abandoned}`,
            pass: continueUser && assistantAfter && continued,
          })

          // Cascade after send-continue so LLM queue order is deterministic
          const zombieBefore = yield* reg.get(parent.id, "explore-zombie")
          const settleHint =
            !!zombieBefore?.lastError?.includes("Not final") &&
            !!zombieBefore.lastError.includes("continue") &&
            !zombieBefore.lastError.includes("session Resume")
          record({
            id: "M1",
            title: "abandon-settle error names send continue (not session Resume)",
            expect: "Not final + continue, no session Resume",
            actual: String(zombieBefore?.lastError ?? ""),
            pass: settleHint,
          })

          console.log(">> cascade start")
          const cascade = yield* prompt
            .cascadeSubagentResume(parent.id)
            .pipe(Effect.timeout("15 seconds"), Effect.catch(() => Effect.succeed([] as never[])))
          console.log(">> cascade done", JSON.stringify(cascade))
          const byId = Object.fromEntries(cascade.map((o) => [o.actorID, o]))
          record({
            id: "C1",
            title: "cascade skips success idle",
            expect: "skipped/no-recovery-candidate",
            actual: `${byId["explore-success"]?.status}/${byId["explore-success"]?.reason}`,
            pass:
              byId["explore-success"]?.status === "skipped" &&
              byId["explore-success"]?.reason === "no-recovery-candidate",
          })
          record({
            id: "C2",
            title: "cascade skips cancelled",
            expect: "skipped/no-recovery-candidate",
            actual: `${byId["general-cancelled"]?.status}/${byId["general-cancelled"]?.reason}`,
            pass:
              byId["general-cancelled"]?.status === "skipped" &&
              byId["general-cancelled"]?.reason === "no-recovery-candidate",
          })
          record({
            id: "C3",
            title: "cascade does not take over running-in-window rows (shared DB ownership)",
            // running + recent activity → deriveLiveness progressing → live skip
            expect: "skipped/live",
            actual: `${byId["general-live"]?.status}/${byId["general-live"]?.reason}`,
            pass: byId["general-live"]?.status === "skipped" && byId["general-live"]?.reason === "live",
          })
          record({
            id: "C4",
            title: "cascade never targets main",
            expect: "no main entry",
            actual: byId["main"] ? `has main: ${byId["main"].status}` : "absent",
            pass: byId["main"] === undefined,
          })
          record({
            id: "C5",
            title: "cascade attempts incomplete zombie",
            expect: "resumed|failed",
            actual: `${byId["explore-zombie"]?.status}`,
            pass: byId["explore-zombie"]?.status === "resumed",
          })
          record({
            id: "C6",
            title: "cascade attempts error assistant",
            expect: "resumed|failed",
            actual: `${byId["explore-error"]?.status}`,
            pass: byId["explore-error"]?.status === "resumed",
          })
          record({
            id: "C7",
            title: "cascade attempts tool-calls assistant",
            expect: "resumed|failed",
            actual: `${byId["explore-toolcalls"]?.status}`,
            pass: byId["explore-toolcalls"]?.status === "resumed",
          })

          // Wait for at least one cascade resume to deliver real model text (C03/C09).
          let cascadeDelivered = false
          for (let i = 0; i < 40 && !cascadeDelivered; i++) {
            for (const id of ["explore-zombie", "explore-error", "explore-toolcalls"] as const) {
              const msgs = yield* sessions.messages({ sessionID: parent.id, agentID: id })
              if (
                msgs.some((m: { parts: Array<{ type: string; text?: string }> }) =>
                  m.parts.some((p) => p.type === "text" && (p.text ?? "").includes("CASCADE-RESUME-OK")),
                )
              ) {
                cascadeDelivered = true
                break
              }
            }
            if (!cascadeDelivered) yield* Effect.sleep("100 millis")
          }
          record({
            id: "C8",
            title: "cascade resume delivers real model text",
            expect: "CASCADE-RESUME-OK in subagent slice",
            actual: `delivered=${cascadeDelivered}`,
            pass: cascadeDelivered,
          })

          return { cascade, results }
        }).pipe(Effect.provide(Inbox.defaultLayer)),
      ).pipe(Effect.scoped, Effect.provide(AppLayer)),
    ),
})

await Instance.disposeAll()

const failed = results.filter((r) => !r.pass)
console.log("\n==== summary ====")
console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`)
if (failed.length) {
  console.log("failed cases:", failed.map((f) => f.id).join(", "))
  process.exitCode = 1
} else {
  console.log("all subagent resume cases passed")
}
