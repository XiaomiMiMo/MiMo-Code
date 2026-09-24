import { HostModelTransport } from "../provider/host-transport"
import { bindHostError, inheritHostError } from "@/error/host-registry"
import path from "path"
import { Provider, ProviderError } from "@/provider"
import { Log } from "@/util"
import { Context, Duration, Effect, Layer, Record, Cause } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool, tool, jsonSchema, NoSuchToolError } from "ai"
import { mergeDeep, pipe } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider"
import { Config } from "@/config"
import { Instance } from "@/project/instance"
import { Agent } from "@/agent/agent"
import { MessageV2 } from "./message-v2"
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
import * as SessionRetry from "./retry"
import { MCP_TOOL_SEARCH_ID } from "@/tool/mcp-tool-search"
import { TOOL_SCRIPT_EXCLUDED } from "@/tool/tool-script-ref"
import { Flag } from "@/flag/flag"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

type Result = Awaited<ReturnType<typeof streamText>>

/**
 * Match transient errors that max-mode local retries should retry.
 *
 * - HTTP 429 / 5xx / 529 — capacity / overload responses
 * - ECONNRESET / EPIPE / ETIMEDOUT — network errors typically caused by
 *   stale keep-alive sockets or upstream proxy timeouts
 * - "SSE read timed out" — `provider.ts:wrapSSE` chunk-timeout fired
 *   (configured per-provider via `chunkTimeout` in mimocode.json). This
 *   is HTTP-byte-level: keep-alive comments still count as activity, so
 *   the error only fires when the underlying TCP stream is genuinely dead.
 *
 * Authentication failures, client errors (400, 404, 422), and user-
 * initiated aborts are NOT retryable.
 *
 * @deprecated Use `isRetryableTransientError` from `./retry` directly.
 * Kept as a 1-line wrapper to preserve the existing export name.
 */
export function isTransientCapacityError(error: unknown): boolean {
  return isRetryableTransientError(error)
}

/**
 * Memory-system instructions appended to the main agent's system prompt.
 *
 * Always injected for main/peer actors (`servesCheckpoint`); memory ownership
 * is not gated on checkpoint. `MIMOCODE_DISABLE_CHECKPOINT` only drops the
 * checkpoint-write subsections:
 * - Always: project MEMORY.md + when the agent may Edit; global MEMORY.md;
 *   session notes.md scratchpad; subagent return format; search-first /
 *   no-ad-hoc-files rules.
 * - When checkpoint is on: checkpoint.md / tasks/<id>/progress.md paths,
 *   writer-as-curator ownership, Active recall protocol after rebuild dumps.
 *
 * `memoryRoot` is the same absolute root returned by Memory.root(), so these
 * paths match the files used by checkpoint restore and memory/task detection.
 */
function buildMemoryInstructions(projectID: ProjectID, memoryRoot: string): string {
  const memoryFile = path.join(memoryRoot, "projects", projectID, "MEMORY.md")
  const sessionMemoryDir = path.join(memoryRoot, "sessions", "current_session_id")
  const globalMemoryFile = path.join(memoryRoot, "global", "MEMORY.md")
  const notesFile = path.join(sessionMemoryDir, "notes.md")
  const checkpointEnabled = !Flag.MIMOCODE_DISABLE_CHECKPOINT

  const files = [
    `- Project memory at \`${memoryFile}\` — persistent across all sessions in this project. Contains: project context, rules, architecture decisions, durable cross-task knowledge.`,
    ...(checkpointEnabled
      ? [
          `- Session checkpoint at \`${path.join(sessionMemoryDir, "checkpoint.md")}\` — current session's structured state, written ONLY by the checkpoint-writer subagent. 11 sections covering active intent, next action, directives, task tree, current work, files, learnings, errors, live resources, design decisions, and open notes. Task content lives inside §4 Task tree and §5 Current work.`,
          `- Per-task progress at \`${path.join(sessionMemoryDir, "tasks", "<id>", "progress.md")}\` — writer-derived splitover from session-level progress.md (not LLM-written). When you spawn a subagent on a task, the subagent may be handed this path for reading; you do not maintain it.`,
        ]
      : []),
    `- Global memory at \`${globalMemoryFile}\` — user-level preferences and cross-project feedback that persist across all projects.${checkpointEnabled ? ` Auto-injected into rebuild context under the "# Global memory" header when present.` : ""}`,
  ]

  const sections = [
    `# Memory system

You have a persistent file-based memory system. ${checkpointEnabled ? "Four" : "Two"} file types:

${files.join("\n")}`,
    ...(checkpointEnabled
      ? [
          "The checkpoint writer is the sole curator of the structured files. You don't maintain them mid-task — the writer extracts everything from the conversation at checkpoint events.",
        ]
      : []),
    `## When to edit MEMORY.md directly

You may edit MEMORY.md when:
- User states a project-level rule that should hold across sessions → ## Rules
- User states a project-level architectural decision → ## Architecture decisions
- A clearly durable cross-session fact emerges that you want available immediately${checkpointEnabled ? ", before the next checkpoint" : ""} → ## Discovered durable knowledge${
      checkpointEnabled
        ? `

These are exceptions, not the norm. The writer covers most extraction at checkpoint time.`
        : ""
    }`,
    `## Notes scratchpad

You have a single legal scratchpad at \`${notesFile}\`. Append entries to it when you want to record:

- A quote (from the user, an article, a known engineer) that has lasting value but isn't a task-specific decision
- An unresolved question — something you noticed but won't answer this turn
- A cross-project observation — "we did this in project X, similar pattern here"
- A note for future-self — context that would matter weeks later but doesn't fit any current task

Format each entry as:
  ## [turn N · YYYY-MM-DDTHH:MM:SSZ]
  Free-form body.${checkpointEnabled ? " The writer reorganizes structured content at checkpoint time." : ""}

This is your ONLY legal scratchpad — don't create \`learning.md\`, \`scratch.md\`, or any other ad-hoc memory file.`,
    `## What NOT to do

${[
  ...(checkpointEnabled ? ["- Don't edit checkpoint.md — that's the writer's domain."] : []),
  "- Don't create memory files other than notes.md (no learning.md, no scratch.md). Use notes.md for any free-form entry.",
  "- Don't ask the user about something memory may already record — search first via the Grep and Read tools.",
].join("\n")}`,
    ...(checkpointEnabled
      ? [
          `## Active recall protocol

After a checkpoint rebuild, the following dumps may be already in your context (look for the "Summary of previous conversation from checkpoint files:" header followed by these dumps):

- checkpoint.md (full or budget-truncated)
- MEMORY.md (full or budget-truncated)
- notes.md (full or budget-truncated)
- global/MEMORY.md (full or budget-truncated)

If these dumps are visible in your context:

- Do NOT read them again as whole files. The bytes are already in front of you.
- For specific past details (a particular turn's content, a specific tool output, an old command), use the Grep tool with a keyword pattern to target the exact item — do not pull a whole file.
- For files NOT in the rebuild dump (per-task splitover progress.md files for tasks you don't actively need, spillover files, older session checkpoints in other sessions), read on demand.

If a dump is budget-truncated, retrieve only the missing section when you need it: use the Read tool with offset/limit.

Memory entries name functions, files, flags, paths — those are CLAIMS about a point in time when they were written. Verify before acting on a specific name.

Don't ask the user about something memory may already record.`,
        ]
      : []),
  ]

  return sections.join("\n\n")
}

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  prebuiltSystem?: string[] // when set, skip buildSystemArray and use this verbatim
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  activeTools?: string[]
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  agentID?: string
  mergeTurnContextIntoLastUser?: boolean
  /** Keep an appended control prompt last while applying provider-specific turn context to the conversation before it. */
  mergeTurnContextBeforeLastMessage?: boolean
  /**
   * Propose-only / ensemble draws: skip Session.Event.RetryAttempt on request-phase
   * ladders. Narrower than `ephemeral` (which also skips plugins, affinity headers,
   * OTel functionId, and system assembly). session.status is already processor-owned.
   */
  quietRetryDiagnostics?: boolean
  retryScope?: "max-candidate" | "max-judge"
  ephemeral?: boolean
  requestID?: string
  assistantMessageID?: string
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

/** Convert per-turn context into the final model-visible user segment. */
export function turnContextMessages(user: MessageV2.User): ModelMessage[] {
  if (user.systemMode === "replace-agent") return []
  const context = user.system?.trim()
  if (!context) return []
  return [{
      role: "user",
      content: `<system-reminder>\n${context}\n</system-reminder>`,
  }]
}

export function appendTurnContext(messages: ModelMessage[], user: MessageV2.User, mergeWithLastUser = false) {
  const context = turnContextMessages(user)
  if (!context.length) return messages
  const last = messages.at(-1)
  if (!mergeWithLastUser || !last || last.role !== "user" || typeof last.content !== "string") {
    return [...messages, ...context]
  }
  return [...messages.slice(0, -1), { ...last, content: last.content + "\n\n" + context[0].content }]
}

function appendTurnContextBeforeLastMessage(messages: ModelMessage[], user: MessageV2.User) {
  const tail = messages.at(-1)
  if (!tail) return appendTurnContext(messages, user, true)
  const head = messages.slice(0, -1)
  const userIndex = head.findLastIndex((message) => message.role === "user")
  if (userIndex < 0) return appendTurnContext(messages, user, true)
  return [
    ...appendTurnContext(head.slice(0, userIndex + 1), user, true),
    ...head.slice(userIndex + 1),
    tail,
  ]
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
  readonly buildSystemArray: (input: {
    agent: Agent.Info
    model: Provider.Model
    system: string[]
    user: MessageV2.User
    sessionID: string
    agentID?: string
    ephemeral?: boolean
  }) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Bus.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | ActorRegistry.Service
  | Memory.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const bus = yield* Bus.Service
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
      ephemeral?: boolean
    }) {
      // "Is this a main/peer actor" — the single judgement memory-instructions
      // and replace-agent base override share. Memory system is ALWAYS taught to
      // these actors; only checkpoint-write copy inside the block is
      // flag-filtered. Injected only for actors whose context the checkpoint
      // flow serves — main + peer. Subagents (explore/general/…) run in the
      // SHARED sessionID (F37 slices) but are NOT main/peer; system-spawned
      // actors (checkpoint-writer et al.) and ephemeral one-shots (title gen)
      // likewise are not. Shares the exact `servesCheckpoint` judgement with
      // SessionPrune.fireCheckpoints so "who owns a checkpoint" and "who is
      // taught about memory" cannot drift apart on the actor axis.
      const servesCheckpoint =
        !input.ephemeral && (yield* actorReg.servesCheckpoint(SessionID.make(input.sessionID), input.agentID))

      // replace-agent replaces the PRIMARY line's base prompt with a session-level
      // system (desktop execution-profile base). It is a main/peer concern: a
      // subagent shares the sessionID and therefore inherits `systemMode` on the
      // resolved session prompt, but must keep its OWN `agent.prompt` — else
      // explore/general/title/… get their identity clobbered by the parent base.
      // So the base override only fires when this actor `servesCheckpoint`; every
      // other actor falls back to SystemPrompt.agent(self).
      const replaceAgent = input.user.systemMode === "replace-agent" && servesCheckpoint

      const system: string[] = []
      system.push(
        [
          // replace-agent is the session's base system prompt, so it must occupy
          // the same leading position as the agent prompt it replaces.
          ...(replaceAgent && input.user.system
            ? [input.user.system]
            : SystemPrompt.agent(input.agent, input.model, input.user.harness)),
        ]
          .filter((x) => x)
          .join("\n"),
      )

      // Memory-instructions section. Always injected for main/peer actors —
      // memory paths/ownership are independent of checkpoint. The checkpoint
      // flag only narrows which subsections buildMemoryInstructions emits
      // (writer/ckpt/Active-recall extras). Project ID is resolved from the
      // ALS-bound Instance with a safe fallback to `ProjectID.global`
      // (mirrors session/checkpoint.ts so advertised paths match writer
      // paths). system-spawned actors (checkpoint-writer et al.) stay out via
      // servesCheckpoint.
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
        system.push(buildMemoryInstructions(projectID, yield* memory.root()))
      }

      // Plugins transform the stable base before the caller-controlled tail.
      yield* plugin.trigger(
        "experimental.chat.system.transform",
        { sessionID: input.sessionID, model: input.model },
        { system },
      )

      // Keep skill reminders at the tail and instruction files after them.
      system.push(...input.system)

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
      const correlationID = input.requestID ?? input.sessionID
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag(input.requestID ? "request.id" : "session.id", correlationID)
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
          ephemeral: input.ephemeral,
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
      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      // Workflow connectors mutate shared session/tool-executor state and may
      // ask permissions. They have no safe isolated title adapter.
      if (input.ephemeral && isWorkflow) return yield* Effect.fail(new Error("Ephemeral workflow generation is unsupported"))
      const providerSystem =
        input.user.systemMode !== "replace-agent" && (isOpenaiOauth || isWorkflow) && input.user.system?.trim()
          ? [...system, input.user.system]
          : system
      if (isOpenaiOauth) options.instructions = providerSystem.join("\n")
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
      const requestMessagesWithContext = input.mergeTurnContextBeforeLastMessage
        ? appendTurnContextBeforeLastMessage(requestMessages, input.user)
        : appendTurnContext(requestMessages, input.user, input.mergeTurnContextIntoLastUser)
      const messages = isOpenaiOauth
        ? requestMessages
        : isWorkflow
          ? requestMessages
          : [
              ...providerSystem.map(
                (x): ModelMessage => ({
                  role: "system",
                  content: x,
                }),
              ),
              ...requestMessagesWithContext,
            ]

      const defaults = {
        temperature: input.model.capabilities.temperature ? (input.agent.temperature ?? ProviderTransform.temperature(input.model)) : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        maxOutputTokens: ProviderTransform.maxOutputTokens(input.model),
        options,
      }
      const params = input.ephemeral ? defaults : yield* plugin.trigger(
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

      const { headers } = input.ephemeral ? { headers: {} } : yield* plugin.trigger(
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
      const requestedActiveTools = new Set(input.activeTools ?? Object.keys(input.tools))
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
          const t = tools[toolName]
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
                span.setAttribute(input.requestID ? "request.id" : "session.id", correlationID)
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
      if (!input.ephemeral) yield* plugin
        .trigger(
          "session.llm.request",
          {
            sessionID: input.sessionID,
            providerID: input.model.providerID,
            modelID: input.model.id,
            trajectory: [
              ...providerSystem.map((content) => ({ role: "system", content })),
              ...(isOpenaiOauth || isWorkflow ? requestMessages : requestMessagesWithContext),
            ],
            systemPrompt: system,
          },
          {},
        )
        .pipe(Effect.ignore)

      const result = streamText({
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
              error: NoSuchToolError.isInstance(failed.error)
                ? new NoSuchToolError({
                    toolName: failed.toolCall.toolName,
                    availableTools: activeTools,
                  }).message
                : failed.error.message,
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
          ...(!input.ephemeral ? { "x-session-affinity": input.sessionID } : {}),
          ...(!input.ephemeral && input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
          ...input.model.headers,
          ...headers,
          "User-Agent": `mimocode/${InstallationVersion}`,
        },
        // Keep one SDK-level retry for a failure before response headers. The
        // processor owns the persistent stream retry budget below this layer.
        maxRetries: input.retries ?? 0,
        messages,
        model: wrapLanguageModel({
          model: language,
          middleware: [
            {
              specificationVersion: "v3" as const,
              wrapStream: ({ doStream, params }) => HostModelTransport.modelCall({
                sessionID: input.sessionID, userMessageID: input.user.id,
                assistantMessageID: input.assistantMessageID,
                providerID: input.model.providerID, modelID: input.model.id, sdk: input.model.api.npm,
                agent: input.agent.name, ephemeral: !!input.ephemeral, format: input.user.format?.type,
              }, async () => {
                const forwardRaw = params.includeRawChunks === true
                params.includeRawChunks = true
                const result = await Promise.resolve().then(doStream).catch((error: unknown) => {
                  bindHostError(error, { providerID: input.model.providerID })
                  throw error
                })
                const reader = result.stream.getReader()
                let cancelled = false
                let pendingRaw: { frame: object; message: string } | undefined
                const stream: typeof result.stream = new ReadableStream({
                  async pull(controller) {
                    try {
                      while (true) {
                        const next = await reader.read()
                        if (cancelled) return
                        if (next.done) {
                          pendingRaw = undefined
                          reader.releaseLock()
                          controller.close()
                          return
                        }
                        if (next.value.type === "raw") {
                          const value = next.value.rawValue
                          pendingRaw = value !== null && typeof value === "object" && !Array.isArray(value) &&
                            "error" in value && value.error !== null && typeof value.error === "object" &&
                            "message" in value.error && typeof value.error.message === "string"
                            ? { frame: value, message: value.error.message } : undefined
                          if (!forwardRaw) continue
                          controller.enqueue(next.value)
                          return
                        }
                        const raw = pendingRaw
                        pendingRaw = undefined
                        if (next.value.type === "error") {
                          // Some adapters emit only the message after an adjacent raw error frame.
                          const error = typeof next.value.error === "string" && raw?.message === next.value.error
                            ? bindHostError({ ...raw.frame, type: "error", message: next.value.error }, { providerID: input.model.providerID }, { responseBody: JSON.stringify(raw.frame) })
                            : bindHostError(next.value.error, { providerID: input.model.providerID })
                          controller.enqueue({ ...next.value, error })
                          return
                        }
                        controller.enqueue(next.value)
                        return
                      }
                    } catch (error) {
                      pendingRaw = undefined
                      if (cancelled) return
                      bindHostError(error, { providerID: input.model.providerID })
                      reader.releaseLock()
                      controller.error(error)
                    }
                  },
                  async cancel(reason) {
                    cancelled = true
                    pendingRaw = undefined
                    try {
                      await reader.cancel(reason)
                    } finally {
                      reader.releaseLock()
                    }
                  },
                })
                return { ...result, stream }
              }),
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
          functionId: input.ephemeral ? "title.llm" : "session.llm",
          tracer: telemetryTracer,
          metadata: {
            userId: cfg.username ?? "unknown",
            ...(input.requestID ? { requestId: correlationID } : { sessionId: input.sessionID }),
          },
        },
      })
      return { result }
    })

    const stream: Interface["stream"] = (input) => {
      // Build the scoped stream for one attempt. `dropAssistantPrefill` forces
      // run() to hard-prune the trailing assistant prefill before send — used only
      // by the reactive one-shot retry below.
      const attempt = (dropAssistantPrefill: boolean, allowRequestRetry: boolean) =>
        Stream.scoped(
          Stream.unwrap(
            Effect.gen(function* () {
              const ctrl = yield* Effect.acquireRelease(
                Effect.sync(() => new AbortController()),
                (ctrl) => Effect.sync(() => ctrl.abort()),
              )
              const result = yield* run({ ...input, abort: ctrl.signal, dropAssistantPrefill })

              // Restore canonical tool IDs before session processing and persistence.
              // The reactive prefill retry remains scoped to request failures.
              const rawStream = Stream.fromAsyncIterable(result.result.fullStream, (e) =>
                inheritHostError(e, { providerID: input.model.providerID }),
              )
              let hasProviderOutput = false
              return rawStream.pipe(
                Stream.mapEffect((event) =>
                  Effect.gen(function* () {
                    if (event.type === "error") inheritHostError(event.error, { providerID: input.model.providerID })
                    if (
                      event.type === "error" &&
                      !hasProviderOutput &&
                      allowRequestRetry &&
                      !ProviderTransform.isAssistantPrefillRejection(event.error)
                    ) {
                      const normalized = MessageV2.fromLiveError(event.error, {
                        providerID: input.model.providerID,
                        aborted: ctrl.signal.aborted,
                        allow404Retry: ProviderError.allowsModelNotFoundRetry(input.model),
                      })
                      if (SessionRetry.decide(normalized, "request", input.retryScope).retryable) return yield* Effect.fail(event.error)
                    }
                    if (event.type !== "start" && event.type !== "error") hasProviderOutput = true
                    return event
                  }),
                ),
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
      const promotePrefillRejection = (stream: Stream.Stream<Event, unknown, never>) =>
        stream.pipe(
          Stream.flatMap((event) =>
            event.type === "error" && ProviderTransform.isAssistantPrefillRejection(event.error)
              ? Stream.fail(event.error)
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
      return Stream.unwrap(
        Effect.gen(function* () {
          const retryConfig = SessionRetry.resolve(yield* config.get(), input.model.providerID)
          const retryRequest = (
            source: Stream.Stream<Event, unknown, never>,
            retryCount: number,
            startedAt?: number,
            prefillRepaired = false,
          ): Stream.Stream<Event, unknown, never> =>
            source.pipe(
              Stream.catchCause((primaryCause) => {
                const primaryError = inheritHostError(Cause.squash(primaryCause), { providerID: input.model.providerID })
                const normalized = MessageV2.fromLiveError(primaryError, { providerID: input.model.providerID, allow404Retry: ProviderError.allowsModelNotFoundRetry(input.model) })
                if (!normalized.data.hostCode && ProviderTransform.isAssistantPrefillRejection(primaryError)) {
                  if (prefillRepaired) return Stream.failCause(primaryCause)
                  return retryRequest(attempt(true, true), retryCount, startedAt, true)
                }
                const decision = SessionRetry.decide(normalized, "request", input.retryScope)
                if (!decision.retryable) return Stream.failCause(primaryCause)
                const budget = SessionRetry.budgetFor(retryConfig, decision)
                const nextAttempt = retryCount + 1
                if (budget.mode === "bounded" && (budget.maxRetries ?? 0) < nextAttempt)
                  return Stream.failCause(primaryCause)
                const deadlineStart = startedAt ?? Date.now()
                const elapsed = Date.now() - deadlineStart
                const wait = SessionRetry.retryDelay(
                  nextAttempt,
                  decision,
                  budget.jitterRatio,
                  budget.initialDelayMs,
                  budget.maxDelayMs,
                )
                if (
                  budget.maxElapsedMs > 0 &&
                  (elapsed >= budget.maxElapsedMs || wait >= budget.maxElapsedMs - elapsed)
                )
                  return Stream.failCause(primaryCause)
                return Stream.unwrap(
                  Effect.gen(function* () {
                    // Request-phase ladders nest inside processor stream retries. Publishing
                    // session.status{retry} here restarts a 200ms×4 burst on every outer
                    // cycle; measured with unreachable baseURL: 4 request + 1 stream per
                    // cycle ≈ 20 UI frames in 32s (looks nothing like exponential backoff).
                    // Session status is owned by processor (user-visible wait); request
                    // attempts stay on Session.Event.RetryAttempt for diagnostics only —
                    // unless the caller is propose-only ensemble (quietRetryDiagnostics).
                    // The Promise bridge would reattach ambient ALS instead of this fiber's InstanceRef.
                    if (!input.ephemeral && !input.quietRetryDiagnostics) yield* bus.publish(Session.Event.RetryAttempt, {
                      sessionID: SessionID.make(input.sessionID),
                      messageID: input.user.id,
                      attempt: nextAttempt,
                      phaseAttempt: nextAttempt,
                      maxAttempts: budget.maxRetries ?? 0,
                      phase: "request",
                      kind: decision.kind,
                      scope: decision.scope,
                      reason: decision.message,
                      nextDelayMs: wait,
                      hostCode: decision.hostCode,
                    })
                    yield* Effect.sleep(Duration.millis(wait))
                    return retryRequest(attempt(false, true), nextAttempt, deadlineStart)
                  }),
                )
              }),
            )
          return retryRequest(promotePrefillRejection(attempt(false, true)), 0)
        }),
      )
    }

    return Service.of({ stream, buildSystemArray })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer), Layer.provide(Bus.defaultLayer))

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
  const disabled = Permission.disabled(Object.keys(input.tools), Agent.runtimePermission(input.agent, input.permission))
  const allowExecGateway =
    input.activeTools?.includes("exec") === true &&
    Object.keys(input.tools).some(
      (key) => !TOOL_SCRIPT_EXCLUDED.has(key) && input.user.tools?.[key] !== false && !disabled.has(key),
    )
  return Record.filter(
    input.tools,
    (_, key) =>
      input.user.tools?.[key] !== false &&
      (!disabled.has(key) ||
        (key === MCP_TOOL_SEARCH_ID && input.activeTools?.includes(key) === true) ||
        (key === "exec" && allowExecGateway)),
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
