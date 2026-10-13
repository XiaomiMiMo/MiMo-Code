import { randomUUID, createHash } from "node:crypto"
import { Cause, Context, Effect, Exit, Fiber, Layer, Scheduler, Scope } from "effect"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import { Instance } from "@/project/instance"
import { HostErrorRegistry } from "@/error/host-registry"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"

export const Tracking = z.object({
  requestID: z.string().min(1).max(256).optional(),
  runtimeID: z.string().min(1).optional(),
})
export const ExecutionRef = z.object({
  runtimeID: z.string(),
  sessionID: SessionID.zod,
  agentID: z.string(),
  executionID: z.string(),
})
export type ExecutionRef = z.infer<typeof ExecutionRef>
export const Info = z.object({
  runtimeID: z.string(),
  sessionID: SessionID.zod,
  requestID: z.string(),
  kind: z.enum(["send", "steer", "command", "resume", "abort"]),
  version: z.number(),
  status: z.enum(["accepted", "handed-off", "completed", "failed", "cancelled"]),
  executionRefs: ExecutionRef.array(),
  userMessageID: z.string().optional(),
  assistantMessageIDs: z.string().array().optional(),
  error: z
    .object({
      name: z.string(),
      data: z.strictObject({
        message: z.string(),
        statusCode: z.number().int().min(100).max(599).optional(),
        isRetryable: z.boolean().optional(),
        hostCode: z.string().optional(),
      }),
    })
    .optional(),
})
export type Info = z.infer<typeof Info>
export const Updated = BusEvent.define("session.request.updated", Info)
export class RequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410,
    message: string,
  ) {
    super(message)
  }
}

type Entry = {
  info: Info
  fingerprint: string
  agentID: string
  fiber?: Fiber.Fiber<unknown, unknown>
  executions: Map<string, Pick<Info, "status" | "error"> | undefined>
}
type Execution = { ref: ExecutionRef; entries: Set<Entry>; release: () => void }
export const Current = Context.Reference<Entry | undefined>("SessionRequests.Current", {
  defaultValue: () => undefined,
})
export const Running = Context.Reference<Execution | undefined>("SessionRequests.Running", {
  defaultValue: () => undefined,
})
const terminal = (info: Info) => info.status === "completed" || info.status === "failed" || info.status === "cancelled"
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value

const errorMessages = new Map([
  ["UnknownError", "Request failed."],
  ["APIError", "Model request failed."],
  ["ProviderAuthError", "Authentication failed. Invalid API Key."],
  ["ProviderModelNotFoundError", "ProviderModelNotFoundError"],
  ["MessageOutputLengthError", "MessageOutputLengthError"],
  ["ContextOverflowError", "ContextOverflowError"],
  ["MessageAbortedError", "Request interrupted."],
  ["StructuredOutputError", "Structured model output failed."],
  ["InvalidOutputError", "Model output was invalid."],
  ["TextToolCallError", "Model tool call output failed."],
  ["ContentFilterError", "The request was rejected because it was considered high risk."],
  ["ModelError", "Model request failed."],
  ["NotFoundError", "Requested resource is unavailable."],
  ["BusyError", "Session is busy."],
  ["ConfigInvalidError", "ConfigInvalidError"],
])

function diagnostic(error: unknown): NonNullable<Info["error"]> {
  const source = error !== null && typeof error === "object" ? error : undefined
  const name = source && "name" in source && typeof source.name === "string" ? source.name : ""
  const message = errorMessages.get(name)
  if (!message) return { name: "UnknownError", data: { message: "Request failed." } }
  const data =
    source && "data" in source && source.data !== null && typeof source.data === "object" ? source.data : undefined
  const status = data && "statusCode" in data ? data.statusCode : undefined
  const statusCode =
    typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
  const retry = data && "isRetryable" in data ? data.isRetryable : undefined
  const host =
    source && "hostCode" in source && source.hostCode
      ? source.hostCode
      : data && "hostCode" in data
        ? data.hostCode
        : undefined
  // Classification strings come from the host's installed catalog, never arbitrary exception data.
  const hostCode = HostErrorRegistry.hostErrorCatalog().rules.find((rule) => rule.code === host)?.code
  return {
    name,
    data: {
      message:
        name !== "APIError"
          ? message
          : statusCode === 401
            ? "Authentication failed. Invalid API Key."
            : statusCode === 429
              ? "Too Many Requests."
              : statusCode === 408 || statusCode === 504
                ? "Request timed out."
                : message,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(typeof retry === "boolean" ? { isRetryable: retry } : {}),
      ...(hostCode ? { hostCode } : {}),
    },
  }
}

const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const state = yield* InstanceState.make(() =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const entries = new Map<SessionID, Map<string, Entry>>()
      const active = new Map<string, Execution>()
      const unsubscribe = yield* bus.subscribeAllCallback((event) => {
        if (event.type === "session.deleted") entries.delete(event.properties.info.id)
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe()
          entries.clear()
          active.clear()
        }),
      )
      return { runtimeID: randomUUID(), entries, active, scope }
    }),
  )
  const update = (entry: Entry, patch: Partial<Info>) =>
    Effect.gen(function* () {
      if (terminal(entry.info)) return
      entry.info = { ...entry.info, ...patch, version: entry.info.version + 1 }
      yield* bus.publish(Updated, entry.info)
    })
  const outcome = (exit: Exit.Exit<unknown, unknown>): Pick<Info, "status" | "error"> => {
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) return { status: "cancelled" }
      return { status: "failed", error: diagnostic(Cause.squash(exit.cause)) }
    }
    const info = (exit.value as MessageV2.WithParts | undefined)?.info
    if (info?.role === "assistant" && info.error) {
      return { status: "failed", error: diagnostic(info.error) }
    }
    return { status: "completed" }
  }
  const list = (sessionID: SessionID, runtimeID?: string) =>
    Effect.gen(function* () {
      const data = yield* InstanceState.get(state)
      if (runtimeID !== undefined && runtimeID !== data.runtimeID)
        throw new RequestError(410, "Engine instance has changed")
      return {
        runtimeID: data.runtimeID,
        requests: [...(data.entries.get(sessionID)?.values() ?? [])].map((entry) => entry.info),
      }
    })
  const get = (sessionID: SessionID, requestID: string, runtimeID?: string) =>
    Effect.gen(function* () {
      const result = yield* list(sessionID, runtimeID)
      const info = result.requests.find((item) => item.requestID === requestID)
      if (!info) throw new RequestError(404, "Unknown engine request")
      return info
    })
  const submit = <A, E, R>(
    input: {
      sessionID: SessionID
      runtimeID?: string
      requestID?: string
      kind: Info["kind"]
      agentID?: string
      payload: unknown
    },
    work: Effect.Effect<A, E, R>,
    prepare?: Effect.Effect<Effect.Effect<A, E, R>, E, R>,
  ) =>
    Effect.gen(function* () {
      const data = yield* InstanceState.get(state)
      if (!input.requestID || !input.runtimeID)
        throw new RequestError(400, "requestID and runtimeID are required together")
      if (input.runtimeID !== data.runtimeID) throw new RequestError(410, "Engine instance has changed")
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify(canonical({ kind: input.kind, agentID: input.agentID ?? "main", payload: input.payload })),
        )
        .digest("hex")
      const entries = data.entries.get(input.sessionID) ?? new Map<string, Entry>()
      data.entries.set(input.sessionID, entries)
      const previous = entries.get(input.requestID)
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new RequestError(409, "Request identity already used with different input")
        return previous.info
      }
      const entry: Entry = {
        fingerprint,
        agentID: input.agentID ?? "main",
        executions: new Map(),
        info: {
          runtimeID: data.runtimeID,
          sessionID: input.sessionID,
          requestID: input.requestID,
          kind: input.kind,
          version: 1,
          status: "accepted",
          executionRefs: [],
        },
      }
      entries.set(input.requestID, entry)
      const prepared = yield* (prepare ?? Effect.succeed(work)).pipe(Effect.provideService(Current, entry), Effect.exit)
      if (Exit.isFailure(prepared)) {
        if (entry.info.kind === "abort" || entry.info.executionRefs.length === 0) yield* update(entry, outcome(prepared))
        return entry.info
      }
      if (terminal(entry.info)) return entry.info
      const release = Instance.claim(yield* InstanceState.directory)
      const fiber = yield* prepared.value.pipe(
        Effect.provideService(Current, entry),
        Effect.provideService(Scheduler.PreventSchedulerYield, false),
        Effect.interruptible,
        Effect.forkIn(data.scope),
      )
      entry.fiber = fiber
      yield* Fiber.await(fiber).pipe(
        Effect.flatMap((exit) =>
          entry.info.kind === "abort" || entry.info.executionRefs.length === 0
            ? update(
                entry,
                Exit.isSuccess(exit) &&
                  (entry.info.kind === "send" || entry.info.kind === "steer") &&
                  entry.info.executionRefs.length === 0 &&
                  (exit.value as MessageV2.WithParts | undefined)?.info.role === "assistant"
                  ? {
                      status: "failed",
                      error: {
                        name: "RequestNotConsumed",
                        data: { message: "The execution exited without consuming this input" },
                      },
                    }
                  : outcome(exit),
              )
            : Effect.void,
        ),
        Effect.ensuring(
          Effect.sync(() => {
            entry.fiber = undefined
            release()
          }),
        ),
        Effect.forkIn(data.scope),
      )
      yield* bus.publish(Updated, entry.info)
      return entry.info
    }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true), Effect.uninterruptible)
  const associate = (execution: Execution, entry: Entry) =>
    Effect.gen(function* () {
      if (
        terminal(entry.info) ||
        execution.ref.runtimeID !== entry.info.runtimeID ||
        execution.ref.sessionID !== entry.info.sessionID ||
        execution.ref.agentID !== entry.agentID
      )
        return
      execution.entries.add(entry)
      if (entry.info.executionRefs.some((ref) => ref.executionID === execution.ref.executionID)) return
      entry.executions.set(execution.ref.executionID, undefined)
      yield* update(entry, { status: "handed-off", executionRefs: [...entry.info.executionRefs, execution.ref] })
    })
  const start = (sessionID: SessionID, agentID: string) =>
    Effect.gen(function* () {
      const data = yield* InstanceState.get(state)
      const executionID = randomUUID()
      const execution: Execution = {
        ref: { runtimeID: data.runtimeID, sessionID, agentID, executionID },
        entries: new Set(),
        release: () => {
          data.active.delete(executionID)
        },
      }
      data.active.set(executionID, execution)
      const entry = yield* Current
      if (entry?.info.kind === "resume") yield* associate(execution, entry)
      return execution
    })
  const finish = (execution: Execution, exit: Exit.Exit<unknown, unknown>) =>
    Effect.forEach(
      execution.entries,
      (entry) => Effect.gen(function* () {
        entry.executions.set(execution.ref.executionID, outcome(exit))
        const outcomes = [...entry.executions.values()]
        if (outcomes.some((result) => !result)) return
        yield* update(
          entry,
          outcomes.find((result) => result?.status === "failed")
            ?? outcomes.find((result) => result?.status === "cancelled")
            ?? { status: "completed" },
        )
      }),
      { discard: true },
    ).pipe(Effect.ensuring(Effect.sync(execution.release)))
  const user = (sessionID: SessionID, userMessageID: string, agentID = "main") =>
    Effect.gen(function* () {
      const entry = yield* Current
      if (entry?.info.sessionID !== sessionID || entry.agentID !== agentID) return
      const data = yield* InstanceState.get(state)
      if (entry.info.runtimeID === data.runtimeID) yield* update(entry, { userMessageID })
    })
  const consume = (
    sessionID: SessionID,
    agentID: string,
    userMessageIDs: readonly string[],
    assistantMessageID?: string,
  ) =>
    Effect.gen(function* () {
      const execution = yield* Running
      if (!execution || execution.ref.sessionID !== sessionID || execution.ref.agentID !== agentID) return
      const data = yield* InstanceState.get(state)
      if (data.runtimeID !== execution.ref.runtimeID) return
      for (const entry of data.entries.get(sessionID)?.values() ?? []) {
        if (entry.agentID !== agentID || terminal(entry.info)) continue
        if (entry.info.userMessageID && userMessageIDs.includes(entry.info.userMessageID))
          yield* associate(execution, entry)
      }
      if (!assistantMessageID) return
      for (const entry of execution.entries) {
        if (entry.info.assistantMessageIDs?.includes(assistantMessageID)) continue
        yield* update(entry, { assistantMessageIDs: [...(entry.info.assistantMessageIDs ?? []), assistantMessageID] })
      }
    })
  const snapshot = (userMessageID: string) =>
    Effect.gen(function* () {
      const execution = yield* Running
      if (!execution) return undefined
      return Object.freeze({
        executionRef: Object.freeze({ ...execution.ref }),
        requestIDs: Object.freeze([...execution.entries].map((entry) => entry.info.requestID)),
        userMessageID,
      })
    })
  const capture = (sessionID: SessionID) =>
    Effect.gen(function* () {
      const data = yield* InstanceState.get(state)
      const self = yield* Current
      if (self?.info.kind === "abort")
        yield* update(self, {
          status: "handed-off",
          executionRefs: [...data.active.values()]
            .filter((execution) => execution.ref.sessionID === sessionID)
            .map((execution) => execution.ref),
        })
      const entries = [...(data.entries.get(sessionID)?.values() ?? [])].filter(
        (entry) => entry !== self && !terminal(entry.info) && entry.info.kind !== "abort",
      )
      return Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            if (entry.info.executionRefs.length > 0) return
            if (entry.fiber) yield* Fiber.interrupt(entry.fiber)
            if (entry.info.executionRefs.length === 0) yield* update(entry, { status: "cancelled" })
          }),
        { concurrency: "unbounded", discard: true },
      )
    })
  const remove = (sessionID: SessionID) =>
    Effect.gen(function* () {
      ;(yield* InstanceState.get(state)).entries.delete(sessionID)
    })
  return { list, get, submit, start, finish, user, consume, snapshot, capture, remove }
})
export class Service extends Context.Service<Service, Effect.Success<typeof make>>()("SessionRequests") {}
export const layer = Layer.effect(Service, make)
export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
export * as SessionRequests from "./requests"
