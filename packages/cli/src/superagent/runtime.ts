import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Instance } from "@/project/instance"
import { Config } from "@/config"
import { setRuntimeDefaults } from "@/config/config"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ActorRegistry } from "@/actor/registry"
import { ActorRegistryTable } from "@/actor/actor.sql"
import { Provider } from "@/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import { inboxControllerRef } from "@/inbox/controller-ref"
import { Worktree } from "@/worktree"
import { Global } from "@/global"
import { Database, eq, and, inArray } from "@/storage"
import { SessionTable, MessageTable } from "@/session/session.sql"
import { MessageV2 } from "@/session/message-v2"
import { InboxTable } from "@/inbox/inbox.sql"
import { desc } from "@/storage"
import { StateTable, ActionTable, InputTable } from "./superagent.sql"
import { routerStateId, SuperagentError, type Ticket } from "./schema"
import * as Dispatcher from "./dispatcher"
import * as Channels from "./channel"
import { loadConfiguredChannels, stopConfiguredChannels } from "./channels/config"
import { Log } from "@/util"

const log = Log.create({ service: "superagent.dispatcher" })
const inflight = new Map<string, Promise<void>>()
let timer: ReturnType<typeof setInterval> | undefined
let starting: Promise<void> | undefined
let ownedDirectory = process.cwd()
let running = false
let pumping = false
export async function prepareWorkspace(directory: string) {
  const owner = Dispatcher.list().find((t) => t.worktree === directory && t.directory !== directory)
  if (owner)
    setRuntimeDefaults(
      directory,
      await at(
        owner.directory,
        Config.Service.use((s) => s.get()),
      ),
    )
}
export const at = async <A, E>(
  directory: string,
  effect: Effect.Effect<
    A,
    E,
    Parameters<typeof AppRuntime.runPromise>[0] extends Effect.Effect<unknown, unknown, infer R> ? R : never
  >,
): Promise<A> => {
  await prepareWorkspace(directory)
  return Instance.provide({
    directory,
    init: () => AppRuntime.runPromise(InstanceBootstrap),
    fn: () => AppRuntime.runPromise(effect),
  })
}

async function session(directory: string, title: string, role: string) {
  return at(
    directory,
    Effect.gen(function* () {
      const sessions = yield* Session.Service,
        actors = yield* ActorRegistry.Service
      yield* SessionPrompt.Service
      const created = yield* sessions.create({ title })
      yield* actors.updateAgent(created.id, "main", role)
      yield* actors.updateStatus(created.id, "main", { status: "idle" })
      return created.id
    }),
  )
}
const routers = new Map<string, Promise<string>>()
export async function router(directory: string) {
  const pending = routers.get(directory)
  if (pending) return pending
  const created = getRouter(directory).finally(() => routers.delete(directory))
  routers.set(directory, created)
  return created
}
async function getRouter(directory: string) {
  const key = routerStateId(directory)
  const previous = Database.use((db) =>
    db.select().from(StateTable).where(eq(StateTable.id, key)).get(),
  )?.router_session_id
  if (
    previous &&
    Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.id, SessionID.make(previous)), eq(SessionTable.directory, directory)))
        .get(),
    )
  )
    return previous
  const id = await session(directory, "Super-agent Router", "superagent-router")
  Database.use((db) =>
    db
      .insert(StateTable)
      .values({ id: key, enabled: true, router_session_id: id })
      .onConflictDoUpdate({ target: StateTable.id, set: { router_session_id: id, enabled: true } })
      .run(),
  )
  return id
}
async function worker(t: Ticket) {
  if (t.workerSessionId) return t
  const config = await at(
    t.directory,
    Config.Service.use((s) => s.get()),
  )
  const directory = await at(
    t.directory,
    Effect.gen(function* () {
      if (Instance.project.vcs === "git") {
        const service = yield* Worktree.Service
        const info = yield* service.makeWorktreeInfo(`task-${t.id}`)
        // Config caches use canonical paths, including on systems where the data directory is a symlink.
        info.directory = path.join(
          yield* Effect.promise(() => realpath(path.dirname(info.directory))),
          path.basename(info.directory),
        )
        setRuntimeDefaults(info.directory, config)
        yield* service.createFromInfo(info)
        return info.directory
      }
      return path.join(Global.Path.data, "superagent", "tasks", t.id)
    }),
  )
  await mkdir(directory, { recursive: true })
  const worktree = await realpath(directory)
  setRuntimeDefaults(worktree, config)
  const sessionId = await session(worktree, t.goal, "superagent-worker")
  const live = Dispatcher.get(t.directory, t.id)
  live.workerSessionId = sessionId
  live.workerActorId = "main"
  live.worktree = worktree
  return Dispatcher.save(live)
}
async function deliver(a: typeof ActionTable.$inferSelect) {
  const row = Dispatcher.input(a.directory, a.payload.inputId!)
  let ticket = a.ticket_id ? Dispatcher.get(a.directory, a.ticket_id) : undefined
  if (ticket && ticket.phase === "cancelled") return
  if (ticket) ticket = await worker(ticket)
  if (ticket?.phase === "cancelled") return
  const directory = ticket?.worktree ?? a.directory
  const sessionId = ticket?.workerSessionId ?? (await router(a.directory))
  const actorId = ticket?.workerActorId ?? "main"
  const messageId = a.payload.messageId ?? MessageID.ascending()
  // Persist the native message identity before accepting it; a crash retries the same Inbox receipt.
  if (!a.payload.messageId)
    Database.use((db) =>
      db
        .update(ActionTable)
        .set({ payload: { ...a.payload, messageId } })
        .where(eq(ActionTable.id, a.id))
        .run(),
    )
  const text = ticket
    ? JSON.stringify({
        ticketId: ticket.id,
        revision: a.payload.revision,
        inputId: row.id,
        goal: ticket.goal,
        criteria: ticket.criteria,
        originalWorkspace: ticket.directory,
        message: row.text,
        source: row.source,
        subscriptions: ticket.subscriptions,
        channels: Channels.list(ticket.directory),
      })
    : JSON.stringify({
        inputId: row.id,
        message: row.text,
        source: row.source,
        returnedReason: a.payload.text,
        tasks: Dispatcher.list(a.directory).map((t) => ({
          id: t.id,
          goal: t.goal,
          phase: t.phase,
          summary: t.summary,
          subscriptions: t.subscriptions,
        })),
      })
  if (ticket) {
    const live = Dispatcher.get(ticket.directory, ticket.id)
    if (live.revision === a.payload.revision && !Dispatcher.terminal(live)) {
      live.phase = "working"
      live.attention = undefined
      Dispatcher.save(live)
    }
  }
  await at(
    directory,
    Effect.gen(function* () {
      yield* SessionPrompt.Service
      const prompts = yield* SessionPrompt.Service,
        actors = yield* ActorRegistry.Service
      const model = row.source.model
        ? { providerID: ProviderID.make(row.source.model.providerID), modelID: ModelID.make(row.source.model.modelID) }
        : yield* (yield* Provider.Service).defaultModel()
      yield* actors.updateAgent(SessionID.make(sessionId), actorId, ticket ? "superagent-worker" : "superagent-router")
      const inbox = inboxControllerRef.current
      if (!inbox) return yield* Effect.fail(new Error("Native Inbox is unavailable"))
      const prepared = yield* prompts.promptAsync({
        sessionID: SessionID.make(sessionId),
        agentID: actorId,
        agent: ticket ? "superagent-worker" : "superagent-router",
        messageID: MessageID.make(messageId),
        model: { providerID: model.providerID, modelID: model.modelID },
        variant: row.source.model?.variant,
        noReply: true,
        harness: "default",
        parts: [
          { type: "text", text: row.text },
          { type: "text", text, synthetic: true },
          ...(row.source.attachments ?? []).map((file) => ({ ...file, type: "file" as const })),
        ],
      })
      if (prepared.message.info.role !== "user")
        return yield* Effect.fail(new Error("Native input must be a user message"))
      if (ticket && Dispatcher.get(ticket.directory, ticket.id).phase === "cancelled") return
      yield* inbox.accept({
        lane: { sessionID: SessionID.make(sessionId), agentID: actorId },
        message: prepared.message.info,
        parts: prepared.message.parts,
        type: "superagent",
        idempotencyKey: ticket ? `superagent:${ticket.id}:${a.payload.revision}:${a.id}` : `superagent-router:${a.id}`,
      })
    }),
  )
}
async function busy(t: Ticket) {
  if (!t.workerSessionId || !t.worktree) return false
  const ids = Dispatcher.sessionIds(t).map((id) => SessionID.make(id))
  return Database.use((db) =>
    db.select().from(ActorRegistryTable).where(inArray(ActorRegistryTable.session_id, ids)).all(),
  ).some(
    (a) =>
      a.status !== "idle" &&
      (a.mode !== "main" || (a.session_id === t.workerSessionId && a.actor_id === (t.workerActorId ?? "main"))),
  )
}
async function reply(a: typeof ActionTable.$inferSelect) {
  const source = a.payload.source!
  if (source.channel !== "local") return Channels.send(a.directory, { id: a.id, source, text: a.payload.text! })
  if (!source.threadId.startsWith("router:")) return
  const original = Database.use((db) =>
    db
      .select()
      .from(InputTable)
      .where(
        and(
          eq(InputTable.directory, a.directory),
          eq(InputTable.channel, source.channel),
          eq(InputTable.event_id, source.eventId),
        ),
      )
      .get(),
  )
  const routed =
    original &&
    Database.use((db) =>
      db
        .select()
        .from(ActionTable)
        .where(eq(ActionTable.key, `route:${original.id}`))
        .get(),
    )
  const parentId = routed?.payload.messageId
  const parent =
    parentId &&
    Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.id, MessageID.make(parentId)))
        .get(),
    )
  if (!parent) return
  const info = MessageV2.Info.parse({ ...parent.data, id: parent.id, sessionID: parent.session_id })
  if (info.role !== "user") return
  const messageId = MessageID.make(a.payload.messageId ?? MessageID.ascending())
  if (!a.payload.messageId)
    Database.use((db) =>
      db
        .update(ActionTable)
        .set({ payload: { ...a.payload, messageId } })
        .where(eq(ActionTable.id, a.id))
        .run(),
    )
  const ticket = a.ticket_id ? Dispatcher.get(a.directory, a.ticket_id) : undefined
  await at(
    a.directory,
    Session.Service.use((s) =>
      Effect.gen(function* () {
        yield* s.updateMessage({
          id: messageId,
          sessionID: parent.session_id,
          agentID: "main",
          role: "assistant",
          parentID: parent.id,
          agent: "superagent-router",
          mode: "superagent-router",
          modelID: info.model.modelID,
          providerID: info.model.providerID,
          path: { cwd: a.directory, root: a.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: a.time_created, completed: Date.now() },
          finish: "stop",
        })
        yield* s.updatePart({
          id: PartID.make(`prt_${a.id}`),
          messageID: messageId,
          sessionID: parent.session_id,
          type: "text",
          text: `${ticket ? `[${ticket.id}] ${ticket.goal}\n\n` : ""}${a.payload.text}`,
        })
      }),
    ),
  )
}
async function perform(a: typeof ActionTable.$inferSelect) {
  try {
    if (a.kind === "route" || a.kind === "deliver") await deliver(a)
    else if (a.kind === "reply") await reply(a)
    else if (a.kind === "stop" && a.ticket_id) {
      const t = Dispatcher.get(a.directory, a.ticket_id)
      if (t.phase === "cancelled" && t.revision === a.payload.revision && t.workerSessionId && t.worktree)
        await at(
          t.worktree,
          SessionPrompt.Service.use((s) => s.cancel(SessionID.make(t.workerSessionId!))),
        )
    } else throw new Error("Unsupported legacy action; inspect the task and explicitly resume it")
    Database.use((db) => db.update(ActionTable).set({ state: "done" }).where(eq(ActionTable.id, a.id)).run())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    Database.use((db) =>
      db.update(ActionTable).set({ state: "failed", error: message }).where(eq(ActionTable.id, a.id)).run(),
    )
    if (a.ticket_id && a.kind === "deliver") {
      const t = Dispatcher.get(a.directory, a.ticket_id)
      if (!Dispatcher.terminal(t)) {
        t.phase = "blocked"
        t.attention = message
        Dispatcher.event(t, "delivery.failed", message)
      }
    }
    log.error("dispatch failed", { action: a.id, error: message })
  }
}
export async function tick() {
  if (!running || pumping) return
  pumping = true
  try {
    const active = new Set<string>()
    for (const t of Dispatcher.list(ownedDirectory).filter((t) => t.version === 2 && !Dispatcher.terminal(t))) {
      if (await busy(t)) {
        active.add(t.id)
        continue
      }
      if (t.phase !== "working" || inflight.has(t.id)) continue
      const actor =
        t.workerSessionId && t.worktree
          ? await at(
              t.worktree,
              ActorRegistry.Service.use((s) => s.get(SessionID.make(t.workerSessionId!), t.workerActorId ?? "main")),
            )
          : undefined
      const receipt = Database.use((db) =>
        db
          .select()
          .from(InboxTable)
          .where(eq(InboxTable.receiver_session_id, SessionID.make(t.workerSessionId!)))
          .orderBy(desc(InboxTable.created_at))
          .all(),
      ).find((r) => r.idempotency_key.startsWith(`superagent:${t.id}:${t.revision}:`))
      if (receipt?.state === "accepted" || receipt?.state === "claimed") {
        active.add(t.id)
        continue
      }
      t.phase = actor?.lastOutcome === "failure" || receipt?.outcome === "assistant_error" ? "blocked" : "waiting"
      t.attention =
        actor?.lastError ||
        (receipt?.outcome === "assistant_error"
          ? "Worker encountered an error. Open its conversation to inspect the error and continue."
          : "Worker stopped without a delivery report. Open its conversation to review progress and continue.")
      Dispatcher.save(t)
    }
    const max = Number(process.env.MIMOCODE_SUPERAGENT_MAX_WORKERS ?? 3)
    if (!Number.isInteger(max) || max < 1) throw new Error("MIMOCODE_SUPERAGENT_MAX_WORKERS must be a positive integer")
    for (const pending of Dispatcher.pending(ownedDirectory)) {
      const lane =
        pending.kind === "route"
          ? `router:${pending.directory}`
          : pending.kind === "reply"
            ? `reply:${pending.directory}`
            : (pending.ticket_id ?? pending.id)
      if (inflight.has(lane)) continue
      if (pending.kind === "deliver" && pending.ticket_id && !active.has(pending.ticket_id) && active.size >= max)
        continue
      const a = Dispatcher.claim(pending.id)
      if (!a) continue
      if (a.kind === "deliver" && a.ticket_id) active.add(a.ticket_id)
      const work = perform(a).finally(() => inflight.delete(lane))
      inflight.set(lane, work)
    }
  } finally {
    pumping = false
  }
}
export async function start(_options?: { directory?: string }) {
  const directory = await realpath(_options?.directory ?? process.cwd())
  if ((running || starting) && directory !== ownedDirectory)
    throw new SuperagentError("This daemon owns a different workspace; start mimo in the requested workspace")
  if (starting) return starting
  if (running) return
  starting = (async () => {
    ownedDirectory = directory
    const max = Number(process.env.MIMOCODE_SUPERAGENT_MAX_WORKERS ?? 3)
    if (!Number.isInteger(max) || max < 1) throw new Error("MIMOCODE_SUPERAGENT_MAX_WORKERS must be a positive integer")
    running = true
    try {
      await loadConfiguredChannels(ownedDirectory)
      Dispatcher.recover(Channels.retryable, ownedDirectory)
      timer = setInterval(() => {
        void tick().catch((error) => log.error("dispatcher tick failed", { error: String(error) }))
      }, 250)
      timer.unref()
      await tick()
    } catch (error) {
      running = false
      throw error
    }
  })().finally(() => {
    starting = undefined
  })
  return starting
}
export async function stop() {
  running = false
  if (timer) clearInterval(timer)
  timer = undefined
  await stopConfiguredChannels()
  await Promise.allSettled([...inflight.values()])
  for (const t of Dispatcher.list(ownedDirectory).filter((t) => t.version === 2 && t.phase === "working")) {
    if (t.workerSessionId && t.worktree)
      await at(
        t.worktree,
        SessionPrompt.Service.use((s) => s.cancel(SessionID.make(t.workerSessionId!))),
      )
  }
  const routerId = Database.use((db) =>
    db
      .select()
      .from(StateTable)
      .where(eq(StateTable.id, routerStateId(ownedDirectory)))
      .get(),
  )?.router_session_id
  if (routerId)
    await at(
      ownedDirectory,
      SessionPrompt.Service.use((s) => s.cancel(SessionID.make(routerId))),
    )
}
export const enabled = () => true
