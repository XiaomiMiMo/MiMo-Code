import path from "path"
import { Provider } from "@/provider"
import { Log } from "@/util"
import { Context, Duration, Effect, Layer, Record, Schedule, Ref, Cause } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { mergeDeep, pipe } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider"
import { Config } from "@/config"
import { Instance } from "@/project/instance"
import { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard, ToolCompat } from "@/util"
import { asSchema } from "@ai-sdk/provider-utils"
import { SessionID } from "@/session/schema"
import * as Session from "@/session/session"
import { migrateProjectMemory } from "./checkpoint-paths"
import { ProjectID } from "@/project/schema"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { InstallationVersion } from "@/installation/version"
import { EffectBridge } from "@/effect"
import { Global } from "@/global"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { ActorRegistry } from "@/actor/registry"
import { Memory } from "@/memory"
import { isRetryableTransientError } from "./retry"
import { MCP_TOOL_SEARCH_ID } from "@/tool/mcp-tool-search"
import { deriveLiveness } from "@/actor/schema"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@/agent/config"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

/**
 * Lead-in for the orchestrator's fleet roster, and the reason the roster carries
 * NO XML envelope.
 *
 * It used to be pushed as `<active-sessions>\n…\n</active-sessions>`, and users
 * saw that literal tag — rows and all — in the TUI. The TUI is not at fault: the
 * roster goes into the SYSTEM array and the TUI never renders system content.
 * The model was quoting it. It had every reason to: `orchestrator.txt` named the
 * tag five times and told it to "Look at `<active-sessions>`", so the tag was
 * vocabulary the prompt had taught it, and the literal string was sitting in its
 * context to copy.
 *
 * Asking it not to echo the tag would be another prompt instruction, and this PR
 * measured what those are worth — the maintainer/author paragraph lost 3/3 live
 * turns. So remove the artifact instead of requesting restraint: with no
 * `<active-sessions>` string anywhere in the assembled request, echoing it is not
 * a behaviour the model can exhibit. The prompt now refers to the roster
 * functionally ("your fleet roster") and keeps the field layout, which is the
 * part that was actually load-bearing for routing.
 *
 * Dropping the delimiter costs nothing structurally: this was the ONLY tagged
 * block in the system array (the agent prompt and the memory instructions are
 * both plain prose), and `dispatchLedgerNotice` already ships the same roster to
 * the model in a tool result with a prose header and no envelope.
 *
 * The "internal working context" sentence is a genuinely weaker lever than the
 * removal — it can only ask. It is here because it costs one line and it sits
 * ADJACENT to the data it governs rather than in a paragraph assembled far away.
 * It does not stop the model paraphrasing a child's title, and it is not claimed
 * to; what is mechanically closed is the literal tag.
 */
export const ROSTER_HEADER =
  "Your fleet — your routable child sessions right now. This list is internal working context, " +
  "not output: never repeat it, or these session ids and titles, back to the user — report the " +
  "routing DECISION instead (\"routing this to the docs child\"). Format is id | title | agent | status:"

// How many FINISHED-but-resumable child sessions the fleet roster carries,
// most-recently-active first. The roster is re-injected on EVERY request,
// so the idle tail (which grows monotonically as children complete) must be
// bounded; running children are self-limiting and are never dropped. A count cap
// rather than a time window, because N children can finish inside one minute and
// a window would not actually bound the block.
export const ROSTER_IDLE_LIMIT = 5
type Result = Awaited<ReturnType<typeof streamText>>

/**
 * Match transient errors that the PERSISTENT_RETRY layer should retry.
 *
 * - HTTP 429 / 5xx / 529 — capacity / overload responses
 * - ECONNRESET / EPIPE / ETIMEDOUT — network errors typically caused by
 *   stale keep-alive sockets or upstream proxy timeouts
 * - "SSE read timed out" — `provider.ts:wrapSSE` chunk-timeout fired
 *   (configured per-provider via `chunkTimeout` in mimocode.json). This
 *   is HTTP-byte-level: keep-alive comments still count as activity, so
 *   the error only fires when the underlying TCP stream is genuinely dead.
 *
 * Auth errors (401/403), client errors (400, 404, 422), and user-
 * initiated aborts are NOT retryable.
 *
 * @deprecated Use `isRetryableTransientError` from `./retry` directly.
 * Kept as a 1-line wrapper to preserve the existing export name.
 */
export function isTransientCapacityError(error: unknown): boolean {
  return isRetryableTransientError(error)
}

/**
 * Persistent-retry schedule with exponential backoff.
 *
 * Exponential backoff 500ms × 2 (i.e. 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256s),
 * each individual delay capped at 5 minutes, total attempts capped at 10.
 *
 * Worst-case total = 11 attempts × chunkTimeout + cumulative backoff
 *                  ≈ 11 × 8min + 9min ≈ 97 min (with DEFAULT_CHUNK_TIMEOUT = 8min).
 *
 * Intentionally NOT capped via Schedule.upTo() — retry persistence under
 * brief upstream outages is the design goal. Bounding per-attempt latency
 * via chunkTimeout is the primary lever for hang-time control.
 */
export const persistentRetrySchedule = Schedule.exponential("500 millis", 2).pipe(
  Schedule.modifyDelay((_, delay) =>
    Effect.succeed(Duration.isLessThanOrEqualTo(delay, Duration.minutes(5)) ? delay : Duration.minutes(5)),
  ),
  Schedule.both(Schedule.recurs(10)),
)

/**
 * Memory-system instructions appended to the main agent's system prompt.
 *
 * Teaches the agent its v8.1 ownership of the memory system:
 * - MEMORY.md (project-scoped): writer is sole curator + agent edits for
 *   project-level user-stated rules
 * - checkpoint.md (session-scoped): writer EXCLUSIVE; agent never edits
 * - tasks/<id>/progress.md: writer-derived splitover from session-level
 *   progress.md; not LLM-written. Subagents handed a task may read but
 *   should not write.
 *
 * Also documents the Active recall protocol that prevents re-Reading
 * files already present in the rebuild dump, and the Subagent return
 * format contract.
 *
 * `memoryRoot` is the same absolute root returned by Memory.root(), so these
 * paths match the files used by checkpoint restore and memory/task detection.
 */
function buildMemoryInstructions(sessionID: SessionID, projectID: ProjectID, memoryRoot: string): string {
  const memoryFile = path.join(memoryRoot, "projects", projectID, "MEMORY.md")
  const checkpointFile = path.join(memoryRoot, "sessions", sessionID, "checkpoint.md")
  const sessionMemoryDir = path.join(memoryRoot, "sessions", sessionID)
  const globalMemoryFile = path.join(memoryRoot, "global", "MEMORY.md")
  return `# Memory system

You have a persistent file-based memory system. Four file types:

- Project memory at \`${memoryFile}\` — persistent across all sessions in this project. Contains: project context, rules, architecture decisions, durable cross-task knowledge.
- Session checkpoint at \`${checkpointFile}\` — current session's structured state, written ONLY by the checkpoint-writer subagent. 11 sections covering active intent, next action, directives, task tree, current work, files, learnings, errors, live resources, design decisions, and open notes. Task content lives inside §4 Task tree and §5 Current work.
- Per-task progress at \`${path.join(sessionMemoryDir, "tasks", "<id>", "progress.md")}\` — writer-derived splitover from session-level progress.md (not LLM-written). When you spawn a subagent on a task, the subagent may be handed this path for reading; you do not maintain it.
- Global memory at \`${globalMemoryFile}\` — user-level preferences and cross-project feedback that persist across all projects. Auto-injected into rebuild context under the "## Global memory" header when present.

The checkpoint writer is the sole curator of the structured files. You don't maintain them mid-task — the writer extracts everything from the conversation at checkpoint events.

## When to Edit MEMORY.md directly

You may Edit MEMORY.md when:
- User states a project-level rule that should hold across sessions → ## Rules
- User states a project-level architectural decision → ## Architecture decisions
- A clearly durable cross-session fact emerges that you want available immediately, before the next checkpoint → ## Discovered durable knowledge

These are exceptions, not the norm. The writer covers most extraction at checkpoint time.

## Notes scratchpad

You have a single legal scratchpad at \`${path.join(sessionMemoryDir, "notes.md")}\`. Append entries to it when you want to record:

- A quote (from the user, an article, a known engineer) that has lasting value but isn't a task-specific decision
- An unresolved question — something you noticed but won't answer this turn
- A cross-project observation — "we did this in project X, similar pattern here"
- A note for future-self — context that would matter weeks later but doesn't fit any current task

Format each entry as:
  ## [turn N · YYYY-MM-DDTHH:MM:SSZ]
  Free-form body. The writer reorganizes structured content at checkpoint time.

This is your ONLY legal scratchpad — don't create \`learning.md\`, \`scratch.md\`, or any other ad-hoc memory file.

## Subagent return format

When you (as a subagent) finish your task, your final assistant message will be delivered to the spawning agent. If the spawn machinery added a "Return format (required)" section to your prompt, follow it exactly:

  **Status**: success | partial | failed | blocked
  **Summary**: <one-line description>

  <deliverable body>

  **Files touched**: <comma-separated paths or "(none)">
  **Findings worth promoting**: <bullet list, or "(none)">

If your spawn prompt didn't include this format (e.g., explore/title/summary agents have their own contracts), follow whatever your prompt specifies.

## What NOT to do

- Don't Edit checkpoint.md — that's the writer's domain.
- Don't create memory files other than notes.md (no learning.md, no scratch.md). Use notes.md for any free-form entry.
- Don't ask the user about something memory may already record — search first via Grep / Read.

## Active recall protocol

After a checkpoint rebuild, the following dumps may be already in your context (look for the "Summary of previous conversation from checkpoint files:" header followed by these dumps):

- checkpoint.md (full or budget-truncated)
- MEMORY.md (full or budget-truncated)
- notes.md (full or budget-truncated)
- global/MEMORY.md (full or budget-truncated)

If these dumps are visible in your context:

- Do NOT Read them again as whole files. The bytes are already in front of you.
- For specific past details (a particular turn's content, a specific tool output, an old command), use Grep with a keyword pattern to target the exact item — do not pull a whole file.
- For files NOT in the rebuild dump (per-task splitover progress.md files for tasks you don't actively need, spillover files, older session checkpoints in other sessions), Read on demand.

If a dump shows "⚠️ Truncated at ~N tokens. Read(<path>, offset=L) for the rest." — that file was budget-cut. Use Read with the offset only when you need the missing tail.

Memory entries name functions, files, flags, paths — those are CLAIMS about a point in time when they were written. Verify before acting on a specific name.

Don't ask the user about something memory may already record.
`
}

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  prebuiltSystem?: string[]      // when set, skip buildSystemArray and use this verbatim
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  activeTools?: string[]
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  agentID?: string
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
  // Set on the reactive one-shot retry after a Bedrock/gateway prefill-rejection
  // 400: hard-prune the trailing assistant (prefill) message(s) before building
  // the request so the resend ends with a user/tool message. See stream(). The
  // proactive guard (ProviderTransform.ensureTrailingUserMessage in message())
  // normally makes this unnecessary; this is a last-resort backstop.
  dropAssistantPrefill?: boolean
}

export type Event = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
  readonly buildSystemArray: (input: {
    agent: Agent.Info
    model: Provider.Model
    system: string[]
    user: MessageV2.User
    sessionID: string
    agentID?: string
  }) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

const live: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | Provider.Service | Plugin.Service | Permission.Service | ActorRegistry.Service | Memory.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const actorReg = yield* ActorRegistry.Service
    const memory = yield* Memory.Service

    const buildSystemArray = Effect.fn("LLM.buildSystemArray")(function* (input: {
      agent: Agent.Info
      model: Provider.Model
      system: string[]
      user: MessageV2.User
      sessionID: string
      agentID?: string
    }) {
      const system: string[] = []
      system.push(
        [
          ...SystemPrompt.agent(input.agent, input.model),
          // any custom prompt passed into this call
          ...input.system,
          // any custom prompt from last user message
          ...(input.user.system ? [input.user.system] : []),
        ]
          .filter((x) => x)
          .join("\n"),
      )

      // v5: memory-instructions section. Teaches the agent how/where/when to
      // maintain `MEMORY.md` and `checkpoint.md` directly via Edit. Project ID is
      // resolved from the ALS-bound Instance with a safe fallback to
      // `ProjectID.global` (mirrors the pattern in session/checkpoint.ts so the
      // path the prompt advertises matches the path the writer actually writes).
      // Injected only for actors whose context the checkpoint flow serves —
      // main + peer. Subagents (explore/general/compose) use per-actor compaction
      // and have no checkpoint duty; system-spawned actors (checkpoint-writer et al.)
      // are the writers themselves. Shares the exact `servesCheckpoint` judgement
      // with SessionPrune.fireCheckpoints so the "who owns a checkpoint" and "who is
      // taught about it" sets can never drift apart.
      const servesCheckpoint = yield* actorReg.servesCheckpoint(SessionID.make(input.sessionID), input.agentID)
      if (servesCheckpoint) {
        const projectID =
          (yield* Effect.try({
            try: () => Instance.current?.project?.id as ProjectID | undefined,
            catch: () => undefined,
          }).pipe(Effect.orElseSucceed(() => undefined))) ?? ProjectID.global
        // Bootstrap the memory.md → MEMORY.md migration at session start so a
        // legacy lowercase file is renamed before the agent's first direct
        // Edit/Write (which would otherwise miss it on a case-sensitive FS, or
        // create an uppercase sibling and orphan the legacy content). The two
        // checkpoint-flow call sites cover the writer/rebuild paths; this covers
        // the "agent edits MEMORY.md before any checkpoint" path. Idempotent.
        yield* Effect.promise(() => migrateProjectMemory(projectID)).pipe(Effect.ignore)
        system.push(buildMemoryInstructions(SessionID.make(input.sessionID), projectID, yield* memory.root()))
      }

      // Orchestrator fleet roster: inject a compact one-line-per-session
      // list of the orchestrator's ROUTABLE child sessions. Only for the orchestrator
      // agent — other agents don't manage children. Format is intentionally compact
      // (~30 tokens/session): id | title | agent | status. Field 3 is the child's
      // AGENT (build/plan/compose) — the routing signal the model needs — not its
      // actor mode, which is always "peer" here and therefore carries no signal.
      // AI needs details on demand → session status/ask.
      if (input.agent.name === "orchestrator") {
        // listPeerChildren joins through the Session row's parent_id, because a
        // peer child registers its actor row under its OWN session id — a
        // session_id-keyed lookup (listByParent) never matches a peer.
        const children = yield* actorReg.listPeerChildren(
          SessionID.make(input.sessionID),
          input.agentID ?? "main",
        )
        const now = Date.now()
        const routable = children
          .filter(({ actor }) => !SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent))
          .map(({ actor, title }) => ({ actor, title, live: deriveLiveness(actor, now) }))
          // Genuinely dead children stay out: `failure` and `cancelled` mean the
          // child errored out or was torn down, so routing work into it is wrong.
          .filter(({ live }) => live !== "failure" && live !== "cancelled")
        // `success` means "its LAST TURN finished cleanly", NOT "the session is
        // gone" — a persistent peer child is still resumable by `session send`
        // (same id, history intact). Dropping those made a child PERMANENTLY
        // invisible the moment it did its job, degrading "route to this topic's
        // standing owner" into "route to whatever id I still remember". Report
        // them honestly as `idle` (the same success→idle mapping `session list`
        // already uses) rather than as `progressing`.
        const working = routable.filter(({ live }) => live === "progressing" || live === "stalled")
        // The idle tail is the only side that grows without bound (children keep
        // finishing; running ones are capped by the machine), so bound IT: keep
        // the most recently active few. Older idle children stay reachable via
        // `session list`, they just don't pay rent in every request.
        const idle = routable
          .filter(({ live }) => live === "success" || live === "idle")
          .sort((a, b) => b.actor.lastTurnTime - a.actor.lastTurnTime)
          .slice(0, ROSTER_IDLE_LIMIT)
        const lines = [...working, ...idle].map(
          ({ actor, title, live }) =>
            `  ${actor.sessionID} | ${title} | ${actor.agent} | ${live === "success" ? "idle" : live}`,
        )
        if (lines.length > 0) system.push(`${ROSTER_HEADER}\n${lines.join("\n")}`)
      }

      // Plugins still see the multi-part array (base prompt as [0], memory as a
      // trailing element) so hooks that index or append parts keep working.
      yield* plugin.trigger(
        "experimental.chat.system.transform",
        { sessionID: input.sessionID, model: input.model },
        { system },
      )

      // Collapse to a single system message. The historical 2-part split existed
      // only to keep a byte-stable cache prefix separate from the memory block's
      // per-session paths — but within a session those paths are fixed, so the
      // whole thing is stable and one block caches just as well. One message also
      // keeps the fork-prefix parity invariant trivial (nothing to misalign) and
      // spares subagents/providers a stray extra system turn. Join with a blank
      // line (\n\n) so adjacent markdown sections (base prompt, "# Memory system")
      // don't run together into one heading.
      return system.length <= 1 ? system : [system.filter((x) => x).join("\n\n")]
    })

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      // TODO: move this to a proper hook
      const isOpenaiOauth = item.id === "openai" && info?.type === "oauth"

      const system =
        input.prebuiltSystem ??
        (yield* buildSystemArray({
          agent: input.agent,
          model: input.model,
          system: input.system,
          user: input.user,
          sessionID: input.sessionID,
          agentID: input.agentID,
        }))

      const variant =
        !input.small && input.model.variants && input.user.model.variant
          ? input.model.variants[input.user.model.variant]
          : {}
      const base = input.small
        ? ProviderTransform.smallOptions(input.model)
        : ProviderTransform.options({
            model: input.model,
            sessionID: input.sessionID,
            providerOptions: item.options,
          })
      const options: Record<string, any> = pipe(
        base,
        mergeDeep(input.model.options),
        mergeDeep(input.agent.options),
        mergeDeep(variant),
      )
      if (isOpenaiOauth) {
        options.instructions = system.join("\n")
      }

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      // Reactive prefill-rejection backstop. The PRIMARY mechanism is the
      // proactive guard in ProviderTransform.message()
      // (ensureTrailingUserMessage): we never send a request ending in an
      // assistant (prefill) turn, and we never delete a completed reply to do so.
      // This reactive path is defense-in-depth: if any code path still slips a
      // trailing assistant through to the wire (e.g. a provider-side transform
      // re-adds one) and the backend 400s on it, run() re-runs with this flag set
      // to hard-prune the trailing assistant turn(s) so the resend ends with a
      // user/tool message. It should effectively never fire, but keeping it is
      // cheap and safe.
      const requestMessages = input.dropAssistantPrefill
        ? ProviderTransform.dropTrailingAssistantPrefill(input.messages)
        : input.messages
      const messages = isOpenaiOauth
        ? requestMessages
        : isWorkflow
          ? requestMessages
          : [
              ...system.map(
                (x): ModelMessage => ({
                  role: "system",
                  content: x,
                }),
              ),
              ...requestMessages,
            ]

      const params = yield* plugin.trigger(
        "chat.params",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          temperature: input.model.capabilities.temperature
            ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
            : undefined,
          topP: input.agent.topP ?? ProviderTransform.topP(input.model),
          topK: ProviderTransform.topK(input.model),
          maxOutputTokens: ProviderTransform.maxOutputTokens(input.model),
          options,
        },
      )

      const { headers } = yield* plugin.trigger(
        "chat.headers",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          headers: {},
        },
      )

      const tools = resolveTools(input)
      const requestedActiveTools = new Set(input.activeTools ?? Object.keys(tools))
      const activeTools = Object.keys(tools).filter((name) => name !== "invalid" && requestedActiveTools.has(name))

      // LiteLLM and some Anthropic proxies require the tools parameter to be present
      // when message history contains tool calls, even if no tools are being used.
      // Add a dummy tool that is never called to satisfy this validation.
      // This is enabled for:
      // 1. Providers with "litellm" in their ID or API ID (auto-detected)
      // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
      const isLiteLLMProxy =
        item.options?.["litellmProxy"] === true ||
        input.model.providerID.toLowerCase().includes("litellm") ||
        input.model.api.id.toLowerCase().includes("litellm")

      // LiteLLM/Bedrock rejects requests where the message history contains tool
      // calls but no tools param is present. When there are no active tools (e.g.
      // during compaction), inject a stub tool to satisfy the validation requirement.
      // The stub description explicitly tells the model not to call it.
      if (
        (isLiteLLMProxy || input.model.providerID.includes("github-copilot")) &&
        activeTools.length === 0 &&
        hasToolCalls(input.messages)
      ) {
        tools["_noop"] = tool({
          description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              reason: { type: "string", description: "Unused" },
            },
          }),
          execute: async () => ({ output: "", title: "", metadata: {} }),
        })
        activeTools.push("_noop")
      }

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const registered = Object.keys(tools)
          const resolvedName = ToolCompat.resolveName(toolName, registered) ?? toolName
          const t = tools[resolvedName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const schema = await Promise.resolve(asSchema(t.inputSchema).jsonSchema)
            const args = ToolCompat.normalizeInput(ToolCompat.parseToolInput(argsJson), schema)
            const result = await t.execute!(args, {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Agent.runtimePermission(input.agent, input.permission)
        workflowModel.sessionPreapprovedTools = Object.keys(tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = Instance.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionID.ascending()
          let unsub: (() => void) | undefined
          try {
            unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
              if (evt.properties.requestID === id) void evt.properties.reply
            })
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            unsub?.()
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      const streamStartTs = Date.now()
      l.debug("streamText starting", {
        messageID: input.user.id,
        msgCount: messages.length,
        registeredToolCount: Object.keys(tools).length,
        activeToolCount: activeTools.length,
      })
      yield* plugin
        .trigger(
          "session.llm.request",
          {
            sessionID: input.sessionID,
            providerID: input.model.providerID,
            modelID: input.model.id,
            trajectory: [
              ...system.map((content) => ({ role: "system", content })),
              ...requestMessages,
            ],
            systemPrompt: system,
          },
          {},
        )
        .pipe(Effect.ignore)

      return streamText({
        onError(error) {
          l.debug("streamText error", {
            messageID: input.user.id,
            error: error instanceof Error ? error.message : String(error),
            elapsedMs: Date.now() - streamStartTs,
          })
          l.error("stream error", {
            error,
          })
        },
        async experimental_repairToolCall(failed) {
          const repaired = await ToolCompat.repairToolCall({
            toolName: failed.toolCall.toolName,
            input: failed.toolCall.input,
            toolNames: activeTools,
            getSchema: (toolName) => failed.inputSchema({ toolName }),
          })
          if (repaired) {
            l.info("repairing tool call", {
              tool: failed.toolCall.toolName,
              repaired: repaired.toolName,
            })
            return {
              ...failed.toolCall,
              toolName: repaired.toolName,
              input: repaired.input,
            }
          }
          return {
            ...failed.toolCall,
            input: JSON.stringify({
              tool: failed.toolCall.toolName,
              error: failed.error.message,
            }),
            toolName: "invalid",
          }
        },
        temperature: params.temperature,
        topP: params.topP,
        topK: params.topK,
        providerOptions: ProviderTransform.providerOptions(input.model, params.options),
        activeTools,
        tools: ProviderTransform.tools(tools, input.model),
        toolChoice: input.toolChoice,
        maxOutputTokens: params.maxOutputTokens,
        abortSignal: input.abort,
        headers: {
          "x-session-affinity": input.sessionID,
          ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
          ...input.model.headers,
          ...headers,
          "User-Agent": `mimocode/${InstallationVersion}`,
        },
        // AI SDK's internal retry loop is SILENT — it emits no events and does
        // not update session status, so the TUI shows only a dead spinner while
        // it runs. Its backoff is also UNCAPPED (delay *= 2 each attempt, capped
        // only by a retry-after header), so the prior default of 10 meant up to
        // ~34 min (2+4+…+1024s) of invisible retrying before the error surfaced.
        // We keep this layer short (absorb a couple of quick blips) and let the
        // VISIBLE processor-level SessionRetry.policy own long-haul resilience —
        // it publishes `type: "retry"` so the `[retrying attempt #N]` banner
        // shows, and its per-attempt delay is capped at 30s.
        maxRetries: input.retries ?? 2,
        messages,
        model: wrapLanguageModel({
          model: language,
          middleware: [
            {
              specificationVersion: "v3" as const,
              async transformParams(args) {
                // `generate || stream`, matching session/prompt.ts:597. This file's
                // only SDK entrypoint is `streamText` (:599), so narrowing to
                // "stream" is not an active hole today — but it would silently drop
                // the whole transform, including the empty-content invariant, the
                // moment a non-streaming call is added here.
                if (args.type === "generate" || args.type === "stream") {
                  // @ts-expect-error
                  args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
                }
                return args.params
              },
            },
          ],
        }),
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          functionId: "session.llm",
          tracer: telemetryTracer,
          metadata: {
            userId: cfg.username ?? "unknown",
            sessionId: input.sessionID,
          },
        },
      })
    })

    const stream: Interface["stream"] = (input) => {
      // Build the scoped stream for one attempt. `dropAssistantPrefill` forces
      // run() to hard-prune the trailing assistant prefill before send — used only
      // by the reactive one-shot retry below.
      const attempt = (dropAssistantPrefill: boolean) =>
        Stream.scoped(
          Stream.unwrap(
            Effect.gen(function* () {
              const ctrl = yield* Effect.acquireRelease(
                Effect.sync(() => new AbortController()),
                (ctrl) => Effect.sync(() => ctrl.abort()),
              )
              const attemptRef = yield* Ref.make(0)

              const publishRetryEvent = (error: unknown, nextAttempt: number) =>
                Effect.gen(function* () {
                  log.debug("retry attempt", {
                    sessionID: input.sessionID,
                    messageID: input.user.id,
                    attempt: nextAttempt,
                    reason: error instanceof Error ? error.message : String(error),
                  })
                  if (nextAttempt > 10) return
                  const delayMs = Math.min(500 * 2 ** (nextAttempt - 1), 300_000)
                  yield* Effect.promise(() =>
                    Bus.publish(Session.Event.RetryAttempt, {
                      sessionID: SessionID.make(input.sessionID),
                      messageID: input.user.id,
                      attempt: nextAttempt,
                      maxAttempts: 10,
                      reason: error instanceof Error ? error.message : String(error),
                      nextDelayMs: delayMs,
                    })
                  )
                })

              const streamWithTelemetry = run({ ...input, abort: ctrl.signal, dropAssistantPrefill }).pipe(
                Effect.tapError((error) => {
                  if (!isTransientCapacityError(error)) return Effect.void
                  return Ref.updateAndGet(attemptRef, (n) => n + 1).pipe(
                    Effect.flatMap((nextAttempt) => publishRetryEvent(error, nextAttempt))
                  )
                })
              )

              const result = yield* streamWithTelemetry.pipe(
                Effect.retry({
                  while: isTransientCapacityError,
                  schedule: persistentRetrySchedule,
                }),
              )

              // Structurally identical to the pre-guard stream: a bare scoped
              // stream over the provider's fullStream. No per-event combinator, no
              // extra catch layer — so the normal (non-error) event flow and the
              // AbortController scope teardown are exactly as before. The reactive
              // prefill retry is layered lazily below and only pays a cost when an
              // actual error surfaces.
              return Stream.fromAsyncIterable(result.fullStream, (e) =>
                e instanceof Error ? e : new Error(String(e)),
              )
            }),
          ),
        )

      // Promote a prefill-rejection 400 — which arrives as an in-band
      // `{ type: "error", error }` event, not a stream fault — into a stream
      // FAILURE so the reactive retry can catch it. `Stream.flatMap` short-circuits
      // every non-matching event straight through with a pure `Stream.succeed` (no
      // per-event Effect fiber, unlike `Stream.mapEffect`), and the failing branch
      // is only ever constructed for the specific error event. On a clean stream
      // this is a transparent passthrough.
      const promotePrefillRejection = (stream: Stream.Stream<Event, Error, never>) =>
        stream.pipe(
          Stream.flatMap((event) =>
            event.type === "error" && ProviderTransform.isAssistantPrefillRejection(event.error)
              ? Stream.fail(event.error instanceof Error ? event.error : new Error(String(event.error)))
              : Stream.succeed(event),
          ),
        )

      // Reactive prefill-rejection backstop. The proactive
      // ProviderTransform.ensureTrailingUserMessage guard runs on every request,
      // so we should never send a trailing assistant prefill and this path should
      // effectively never fire. It remains as defense-in-depth: if any path still
      // slips a trailing assistant through to the wire and the backend 400s with
      // "does not support assistant message prefill", we key off that deterministic
      // error body — not the model id — and retry exactly ONCE with the prefill
      // hard-pruned. Guarded to a single reprune so a persistent failure surfaces
      // the retry's OWN error, falling back to the original prefill cause only when
      // the resend is again prefill-rejected.
      return promotePrefillRejection(attempt(false)).pipe(
        Stream.catchCause((primaryCause) => {
          if (!ProviderTransform.isAssistantPrefillRejection(Cause.squash(primaryCause)))
            return Stream.failCause(primaryCause)
          // Pruned resend passes events through untouched: any residual error flows
          // to the processor and surfaces normally (no promotion, no loop).
          return attempt(true).pipe(
            Stream.catchCause((retryCause) =>
              ProviderTransform.isAssistantPrefillRejection(Cause.squash(retryCause))
                ? Stream.failCause(primaryCause)
                : Stream.failCause(retryCause),
            ),
          )
        }),
      )
    }

    return Service.of({ stream, buildSystemArray })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(ActorRegistry.defaultLayer),
    Layer.provide(Memory.defaultLayer),
  ),
)

function resolveTools(input: Pick<StreamInput, "tools" | "activeTools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Agent.runtimePermission(input.agent, input.permission),
  )
  return Record.filter(
    input.tools,
    (_, key) =>
      input.user.tools?.[key] !== false &&
      (!disabled.has(key) || (key === MCP_TOOL_SEARCH_ID && input.activeTools?.includes(key) === true)),
  )
}

// Check if messages contain any tool-call content
// Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLM from "./llm"
