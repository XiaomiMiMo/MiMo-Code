import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  SessionTaskResponse,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
} from "@mimo-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@mimo-ai/shared/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import { Log } from "@/util"
import { isDirectoryDeniedError } from "@/server/routes/instance/access"
import { useToastOptional } from "../ui/toast"
import { emptyConsoleState, type ConsoleState } from "@/config/console-state"

/**
 * The SDK regenerated the task list as an inline anonymous array on
 * `SessionTaskResponse` rather than a named `Task` export (the zod schema is not
 * surfaced as a reusable component). Derive the element type so the store and
 * plugin API stay in lockstep with the server's `GET /:sessionID/task` shape.
 */
export type Task = SessionTaskResponse[number]

/**
 * TUI-side view of a dynamic-workflow run (server route `GET /workflows`, bus
 * events `workflow.started/phase/finished`). The list route serializes the
 * runtime's `RunSummary` but is described as `z.array(z.any())`, so the SDK gen
 * surfaces it as `Array<unknown>` rather than a named export — mirror the
 * server's `RunSummary` shape here so the store and the dialog stay in lockstep.
 */
export type WorkflowRun = {
  runID: string
  sessionID: string
  name: string
  status: string
  running: number
  succeeded: number
  failed: number
  currentPhase?: string
  parentActorID?: string
  args?: unknown
  error?: string
  createdAt?: number
  updatedAt?: number
}

// Mirror of the runtime's WorkflowNode union (server route serializes it as
// z.array(z.any())). The single TUI-side definition reused by the detail dialog
// and the tree renderer.
export type WorkflowNode =
  | { type: "phase"; id: string; title: string }
  | {
      type: "agent"
      id: string
      phaseId?: string
      label?: string
      agentType: string
      prompt: string
      model?: string
      tools?: string[]
      schema?: boolean
      isolation?: boolean
      actorID?: string
      durationMs?: number
      resultSummary?: string
      resultFull?: string
      status: "running" | "succeeded" | "failed"
    }
  | {
      type: "workflow"
      id: string
      phaseId?: string
      childRunID: string
      name: string
      args?: unknown
      status: "running" | "completed" | "failed" | "cancelled"
    }

/**
 * TUI-side view of a session's stop-condition goal (server event `session.goal`).
 * `condition` is the active goal (undefined once cleared/satisfied/impossible).
 * `verdicts` accumulates each judge verdict keyed by the assistant message it
 * evaluated, so a per-turn marker can be rendered against the right turn and the
 * user can trace back which turn failed the check. `lastMessageID` points at the
 * most recently judged turn.
 */
export type GoalVerdict = {
  ok: boolean
  impossible?: boolean
  reason: string
  attempt: number
  error?: boolean
}

export type SessionGoal = {
  condition?: string
  verdicts: { [messageID: string]: GoalVerdict }
  lastMessageID?: string
}

export type ActorEntry = {
  actor_id: string
  session_id: string
  mode: "subagent" | "peer" | "main"
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown"
  agent: string
  description: string
  parent_actor_id: string | null
  time_created: number
  time_updated: number
  turn_count: number
  last_turn_time: number | null
}

function actorStatusFromEvent(
  s: "pending" | "running" | "idle",
  outcome: "success" | "failure" | "cancelled" | undefined,
): ActorEntry["status"] {
  if (s === "pending") return "pending"
  if (s === "running") return "running"
  if (outcome === "success") return "completed"
  if (outcome === "failure") return "failed"
  if (outcome === "cancelled") return "cancelled"
  return "unknown"
}

export function bucketMessages<M extends { agentID?: string | null }>(
  msgs: M[],
): Record<string, M[]> {
  const out: Record<string, M[]> = {}
  for (const m of msgs) {
    const k = m.agentID ?? "main"
    if (!out[k]) out[k] = []
    out[k].push(m)
  }
  return out
}

/**
 * A `session.status` event is authoritative for the WHOLE status object.
 *
 * Solid's store setter merges plain objects into the existing node
 * (`mergeStoreNode` only writes `Object.keys(next)`), so writing a bare
 * `{ type: "busy" }` — which is what the runner emits at the start of every turn
 * (session/run-state.ts:74) — inherits the `message` of whatever status was
 * written before it. That latched `/rebuild` outcome text
 * (session/prompt.ts:4173) into the following turn's spinner. `reconcile()`
 * drops the fields the new status omits, so each status stands alone.
 */
export function nextSessionStatus(status: SessionStatus) {
  return reconcile(status)
}

// Pick the bucket the session view should render. `main` is the normal case; a
// peer child (spawn.ts) runs its turns under agentID == its own sessionID, so
// attaching to one lands on agentID "main" with an empty main bucket and must
// fall back to the self-id bucket. A session whose turns ran under an ACTOR id
// has neither key — its bucket is "build-1" / "compose-1" / "general-1" — so
// without the last arm it renders a blank pane over a full transcript.
//
// ⚠️Do not delete the last arm again. An earlier revision of this branch removed
// it on the reasoning that its only population was internal machinery. That
// inference is now backwards: the route refuses a machinery session BEFORE the
// transcript is selected (routes/session/index.tsx → session/visibility.ts), so
// this fallback can no longer be the thing that renders a checkpoint-writer
// transcript. Everything that still reaches it is a session the product has
// already decided to show. Measured on the live DB, the 1313 sessions this arm
// serves split 1302 checkpoint-writer hosts (refused upstream, never arrive
// here) and 11 `session ask` fork-query hosts whose buckets are build-1 ×7,
// compose-1 ×3, general-1 ×1 — those 11 are model-spawned read-only transcripts
// and a blank pane for them is the original bug (#1964). Those counts are one
// read-only local-DB snapshot and they drift — this arm's population grew
// 1294 → 1313 across this branch's own revisions — so trust the split's shape,
// not the absolute numbers.
export function selectMessages<M extends { id: string }>(
  buckets: Record<string, M[]> | undefined,
  agentID: string,
  sessionID: string,
): M[] {
  if (agentID !== "main" || buckets?.["main"]?.length) return buckets?.[agentID] ?? []
  if (buckets?.[sessionID]?.length) return buckets[sessionID]
  const newest = Object.entries(buckets ?? {})
    .filter(([key, msgs]) => key !== "main" && msgs.length > 0)
    .sort(([, a], [, b]) => (b.at(-1)?.id ?? "").localeCompare(a.at(-1)?.id ?? ""))
    .at(0)
  return newest?.[1] ?? []
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_goal: {
        [sessionID: string]: SessionGoal
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      session_cwd: {
        [sessionID: string]: string
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      task: {
        [sessionID: string]: Task[]
      }
      message: {
        [sessionID: string]: {
          [agentID: string]: Message[]
        }
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      instructions: string[]
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
      actor: {
        [sessionID: string]: ActorEntry[]
      }
      workflow: {
        [runID: string]: WorkflowRun
      }
      workflowTranscript: {
        [runID: string]: { kind: "phase" | "log"; text: string }[]
      }
      workflowStructure: {
        [runID: string]: WorkflowNode[]
      }
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
        authenticated: [],
      },
      console_state: emptyConsoleState,
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_goal: {},
      session_diff: {},
      session_cwd: {},
      todo: {},
      task: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      instructions: [],
      formatter: [],
      vcs: undefined,
      actor: {},
      workflow: {},
      workflowTranscript: {},
      workflowStructure: {},
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const toast = useToastOptional()

    // A bootstrap that nobody awaits still must not fail silently when the
    // server's directory whitelist is the reason. `bootstrap` rethrows the
    // recoverable policy rejection so an interactive caller can restore the
    // previous directory and explain itself; the two fire-and-forget callers
    // below have no such caller, so without this the TUI would sit with stale
    // data and no indication why. Genuinely fatal failures already exited
    // inside bootstrap, and anything else is logged there.
    const reportDenied = (e: unknown) => {
      if (!isDirectoryDeniedError(e)) return
      toast?.show({
        message: `Cannot use ${sdk.directory ?? "this directory"}: outside this server's working directory`,
        variant: "error",
      })
    }

    const fullSyncedSessions = new Set<string>()
    let syncedWorkspace = project.workspace.current()
    let syncedDirectory = sdk.directory

    event.subscribe((event) => {
      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap().catch(reportDenied)
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "task.created": {
          const { sessionID, task } = event.properties
          const list = store.task[sessionID]
          if (!list) {
            setStore("task", sessionID, [task])
            break
          }
          const idx = list.findIndex((t) => t.id === task.id)
          setStore(
            "task",
            sessionID,
            produce((draft) => {
              if (idx >= 0) draft[idx] = task
              else draft.push(task)
            }),
          )
          break
        }

        case "task.updated": {
          const { sessionID, task } = event.properties
          const list = store.task[sessionID]
          if (!list) {
            setStore("task", sessionID, [task])
            break
          }
          const idx = list.findIndex((t) => t.id === task.id)
          if (idx < 0) {
            setStore(
              "task",
              sessionID,
              produce((draft) => {
                draft.push(task)
              }),
            )
            break
          }
          setStore("task", sessionID, idx, reconcile(task))
          break
        }

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.cwd":
          setStore("session_cwd", event.properties.sessionID, event.properties.cwd)
          break

        case "session.deleted": {
          const sid = event.properties.info.id
          const result = Binary.search(store.session, sid, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          // Evict every per-session bucket keyed by sessionID so child sessions
          // that end don't leak their message/part/actor/task/etc. entries.
          setStore(
            produce((s) => {
              delete s.permission[sid]
              delete s.question[sid]
              delete s.session_status[sid]
              delete s.session_goal[sid]
              delete s.session_diff[sid]
              delete s.session_cwd[sid]
              delete s.todo[sid]
              delete s.task[sid]
              delete s.actor[sid]
              const agents = s.message[sid]
              if (agents) {
                for (const msgs of Object.values(agents)) {
                  for (const m of msgs) delete s.part[m.id]
                }
              }
              delete s.message[sid]
            }),
          )
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, nextSessionStatus(event.properties.status))
          break
        }

        case "session.goal": {
          // Merge: a clear event (goal:undefined) keeps the accumulated verdicts
          // (so per-turn markers persist for traceback); a verdict carrying a
          // messageID is recorded against that turn.
          setStore("session_goal", event.properties.sessionID, (prev) => {
            const verdicts = { ...(prev?.verdicts ?? {}) }
            const v = event.properties.lastVerdict
            let lastMessageID = prev?.lastMessageID
            if (v?.messageID) {
              verdicts[v.messageID] = {
                ok: v.ok,
                impossible: v.impossible,
                reason: v.reason,
                attempt: v.attempt,
                error: v.error,
              }
              lastMessageID = v.messageID
            }
            return {
              condition: event.properties.goal?.condition,
              verdicts,
              lastMessageID,
            }
          })
          break
        }

        case "message.updated": {
          // Bucket every message by agentID. Pre-rewire the TUI dropped non-main
          // messages here; now subagent slices are first-class buckets and the
          // session view renders whichever bucket matches route.agentID.
          const sid = event.properties.info.sessionID
          const aid = event.properties.info.agentID ?? "main"
          if (!store.message[sid]) {
            setStore("message", sid, { [aid]: [event.properties.info] })
            break
          }
          if (!store.message[sid][aid]) {
            setStore("message", sid, aid, [event.properties.info])
            break
          }
          const messages = store.message[sid][aid]
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", sid, aid, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            sid,
            aid,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[sid][aid]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                sid,
                aid,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          const sid = event.properties.sessionID
          const buckets = store.message[sid]
          if (!buckets) break
          for (const aid of Object.keys(buckets)) {
            const messages = buckets[aid]
            const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
            if (result.found) {
              setStore(
                "message",
                sid,
                aid,
                produce((draft) => {
                  draft.splice(result.index, 1)
                }),
              )
              break
            }
          }
          break
        }
        case "message.part.updated": {
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "tui.instructions.loaded": {
          setStore("instructions", reconcile(event.properties.files))
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          setStore("vcs", { branch: event.properties.branch })
          break
        }

        case "actor.registered": {
          const sid = event.properties.sessionID
          const list = store.actor[sid] ?? []
          if (list.find((a) => a.actor_id === event.properties.actorID)) break
          const entry: ActorEntry = {
            actor_id: event.properties.actorID,
            session_id: event.properties.sessionID,
            mode: event.properties.mode as ActorEntry["mode"],
            status: "pending",
            agent: event.properties.agent,
            description: event.properties.description,
            parent_actor_id: event.properties.parentActorID ?? null,
            time_created: Date.now(),
            time_updated: Date.now(),
            turn_count: 0,
            last_turn_time: null,
          }
          setStore("actor", sid, [...list, entry].toSorted((a, b) => a.time_created - b.time_created))
          break
        }

        case "actor.status": {
          const sid = event.properties.sessionID
          const list = store.actor[sid] ?? []
          const idx = list.findIndex((a) => a.actor_id === event.properties.actorID)
          if (idx === -1) break
          setStore("actor", sid, idx, {
            status: actorStatusFromEvent(
              event.properties.status,
              event.properties.lastOutcome,
            ),
            turn_count: event.properties.turnCount,
            last_turn_time: event.properties.lastTurnTime,
            time_updated: Date.now(),
          })
          break
        }

        case "workflow.started": {
          // Upsert a fresh run row; counters stay zero until loadWorkflows /
          // the dialog's poll (T7) refreshes them from the list route.
          setStore("workflow", event.properties.runID, {
            runID: event.properties.runID,
            sessionID: event.properties.sessionID,
            name: event.properties.name,
            status: "running",
            running: 0,
            succeeded: 0,
            failed: 0,
          })
          break
        }

        case "workflow.phase": {
          if (!store.workflow[event.properties.runID]) break
          setStore("workflow", event.properties.runID, "currentPhase", event.properties.title)
          break
        }

        case "workflow.finished": {
          if (!store.workflow[event.properties.runID]) break
          setStore("workflow", event.properties.runID, "status", event.properties.status)
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const directory = sdk.directory
      // fullSyncedSessions exists to keep a re-entered session from refetching its
      // whole transcript on every navigation. That cache is scoped to the data
      // source, so it must be dropped whenever the source changes — a workspace
      // switch OR a directory switch (sdk.switchDirectory). Without the directory
      // half, a session synced before the switch can never be re-synced, so any
      // update missed during the switch window stays invisible for the rest of the
      // session. An unchanged workspace+directory still short-circuits.
      if (workspace !== syncedWorkspace || directory !== syncedDirectory) {
        fullSyncedSessions.clear()
        syncedWorkspace = workspace
        syncedDirectory = directory
      }
      // A bootstrap can outlive the directory it describes: `dispose +
      // switchDirectory + bootstrap` ALSO re-fires bootstrap from the
      // `server.instance.disposed` handler above, and that run built its requests
      // from the PRE-switch client. Staleness therefore has to be re-checked AFTER
      // each await rather than once before them — a switch landing while these
      // requests are in flight must not write the old directory's data into the
      // store, or the store ends up describing a directory sdk no longer talks to.
      // When no directory was ever set (single-directory mode) nothing can switch
      // and this is always false. `directory` above is the captured generation.
      const stale = () => sdk.directory !== directory
      // Same check for the NON-blocking writes, which each resolve on their own.
      const guard = <T,>(request: Promise<T>, apply: (value: T) => void) =>
        request.then((value) => {
          if (stale()) return
          apply(value)
        })
      const start = Date.now() - 30 * 24 * 60 * 60 * 1000
      // roots: true so child sessions (subagents, workers) don't crowd root
      // sessions out of the server-side limit
      const sessionListPromise = sdk.client.session
        .list({ start: start, roots: true })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      const projectPromise = project.sync()
      const blockingRequests: Promise<unknown>[] = [
        providersPromise,
        providerListPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ]

      await Promise.all(blockingRequests)
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            if (stale()) return
            const providers = responses[0]
            const providerList = responses[1]
            const consoleState = responses[2]
            const agents = responses[3]
            const config = responses[4]
            const sessions = responses[5]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (stale()) return
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue
              ? []
              : [guard(sessionListPromise, (sessions) => setStore("session", reconcile(sessions)))]),
            guard(consoleStatePromise, (consoleState) => setStore("console_state", reconcile(consoleState))),
            guard(sdk.client.command.list({ workspace }), (x) => setStore("command", reconcile(x.data ?? []))),
            guard(sdk.client.lsp.status({ workspace }), (x) => setStore("lsp", reconcile(x.data ?? []))),
            guard(sdk.client.mcp.status({ workspace }), (x) => setStore("mcp", reconcile(x.data ?? {}))),
            guard(sdk.client.experimental.resource.list({ workspace }), (x) =>
              setStore("mcp_resource", reconcile(x.data ?? {})),
            ),
            guard(sdk.client.formatter.status({ workspace }), (x) => setStore("formatter", reconcile(x.data ?? []))),
            guard(sdk.client.session.status({ workspace }), (x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            guard(sdk.client.provider.auth({ workspace }), (x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            guard(sdk.client.vcs.get({ workspace }), (x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ]).then(() => {
            // A superseded run must not declare the CURRENT directory's sync
            // complete — that would unblock the UI on data it never wrote.
            if (stale()) return
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          Log.Default.error("tui bootstrap failed", {
            error: isDirectoryDeniedError(e) ? e.error : e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          // The server's directory whitelist rejecting the requested directory is a
          // recoverable policy decision, not a broken TUI: exiting here would take
          // the user's whole session down over a mistyped/untrusted path. Always
          // rethrow so the switch caller can restore the previous directory and show
          // the error. Genuinely fatal bootstrap failures still exit.
          if (fatal && !isDirectoryDeniedError(e)) {
            await exit(e)
            return
          }
          throw e
        })
    }

    onMount(() => {
      // Errors are already logged (and exited on, when fatal) inside bootstrap; the
      // rethrown recoverable case has no caller here, so swallow it rather than
      // emitting an unhandled rejection.
      void bootstrap().catch(reportDenied)
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (process.env.MIMOCODE_FAST_BOOT) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        async refresh() {
          const start = Date.now() - 30 * 24 * 60 * 60 * 1000
          const list = await sdk.client.session
            .list({ start, roots: true })
            .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
          setStore("session", reconcile(list))
        },
        // Resolve THE root session of the directory the client currently talks
        // to, creating one only when the server really has none.
        //
        // Reading store.session for this is a race: bootstrap issues session.list
        // as a NON-BLOCKING request (it only joins blockingRequests for
        // `--continue`), so `await bootstrap()` resolves BEFORE the list lands. A
        // caller that reads the store right after it sees an empty (or pre-switch)
        // list, concludes there is no root, and mints another one — entering
        // Orchestrator three times produced three roots. Refreshing from the
        // server first makes the decision depend on data instead of on timing.
        async resolveRoot() {
          await result.session.refresh()
          const existing = store.session
            .filter((x) => x.parentID === undefined)
            .toSorted((a, b) => b.time.updated - a.time.updated)
            .at(0)
          if (existing) return { id: existing.id, created: false }
          return { id: (await sdk.client.session.create({})).data?.id, created: true }
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID]?.["main"] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const [session, messages, todo, diff, actors, task, children] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            // ⚠️`limit` is ONE budget shared across every agent bucket, not a
            // per-bucket limit. A session whose real `main` history is crowded out
            // of the newest 100 therefore arrives with an empty `main` and falls
            // through to a non-main bucket in selectMessages above. Measured on the
            // live DB: 1 of 4613 sessions with messages. Left as-is deliberately —
            // a separate concern from the render prohibition — and no server work
            // is needed to fix it, since this endpoint already returns up to 1000
            // when `limit` is omitted.
            sdk.client.session.messages({ sessionID, limit: 100, agent_id: "*" }),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
            sdk.client.session.actors({ sessionID }),
            sdk.client.session.task({ sessionID }),
            // children aren't in the root-only session list; fetch them so the
            // session dialog can show the current session's child sessions.
            // visible: true returns only peer children, dropping the two other
            // kinds of child session that exist — the checkpoint-writer host
            // (session/checkpoint.ts:851) and the `session ask` fork-query host
            // (tool/session.ts:128). See Session.children for why "workflow
            // subagent sessions" is not a third kind.
            sdk.client.session.children({ sessionID, visible: true }).catch(() => undefined),
          ])
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = session.data!
              if (!match.found) draft.session.splice(match.index, 0, session.data!)
              for (const child of children?.data ?? []) {
                const childMatch = Binary.search(draft.session, child.id, (s) => s.id)
                if (childMatch.found) draft.session[childMatch.index] = child
                if (!childMatch.found) draft.session.splice(childMatch.index, 0, child)
              }
              draft.todo[sessionID] = todo.data ?? []
              draft.task[sessionID] = task.data ?? []
              const flat = (messages.data ?? []).map((x) => x.info)
              // Server returns messages id-ordered and message.updated keeps that order; the footer's post-/rebuild pending-detection deliberately does NOT depend on it (it keys off checkpoint coveredUpTo, model.ts), so reordering here won't resurface the stale-context bug.
              draft.message[sessionID] = bucketMessages(flat)
              for (const message of messages.data ?? []) {
                draft.part[message.info.id] = message.parts
              }
              draft.session_diff[sessionID] = diff.data ?? []
              draft.actor[sessionID] = ((actors.data ?? []) as any[]).map((row): ActorEntry => ({
                actor_id: row.actorID,
                session_id: row.sessionID,
                mode: row.mode,
                status: actorStatusFromEvent(row.status, row.lastOutcome),
                agent: row.agent,
                description: row.description,
                parent_actor_id: row.parentActorID ?? null,
                time_created: row.time?.created ?? Date.now(),
                time_updated: row.time?.updated ?? Date.now(),
                turn_count: row.turnCount ?? 0,
                last_turn_time: row.lastTurnTime ?? null,
              }))
            }),
          )
          fullSyncedSessions.add(sessionID)
        },
      },
      bootstrap,
      loadWorkflows(sessionID: string) {
        void sdk.client.workflow.list({ sessionID }).then((res) => {
          for (const run of (res.data ?? []) as WorkflowRun[]) setStore("workflow", run.runID, reconcile(run))
        })
      },
      resumeWorkflow(runID: string) {
        return sdk.client.workflow.resume({ runID })
      },
      loadWorkflowTranscript(runID: string) {
        void sdk.client.workflow.transcript({ runID }).then((res) => {
          const t = (res.data as { transcript?: { kind: "phase" | "log"; text: string }[] } | undefined)?.transcript
          // reconcile so the 1s poll merges into the existing array (append-only,
          // stable by index) instead of swapping in all-new refs every tick.
          if (Array.isArray(t)) setStore("workflowTranscript", runID, reconcile(t))
        })
      },
      loadWorkflowStructure(runID: string) {
        void sdk.client.workflow.structure({ runID }).then((res) => {
          const n = (res.data as { nodes?: WorkflowNode[] } | undefined)?.nodes
          // reconcile keyed by node id so unchanged cards keep their object identity
          // across the 1s poll — otherwise <For> (ref-keyed) remounts every card each
          // tick, dropping hover state and flickering.
          if (Array.isArray(n)) setStore("workflowStructure", runID, reconcile(n, { key: "id" }))
        })
      },
    }
    return result
  },
})
