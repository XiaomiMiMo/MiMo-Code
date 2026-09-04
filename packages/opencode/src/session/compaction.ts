import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "../provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util"
import { Log } from "../util"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config"
import { NotFoundError } from "@/storage"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect"
import { isOverflow as overflow } from "./overflow"
import { makeRuntime } from "@/effect/run-service"
import { fn } from "@/util/fn"
import path from "path"
import { SessionPrefixSnapshot } from "./prefix-snapshot"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    z.object({
      sessionID: SessionID.zod,
      // Optional: identifies which agent slice was compacted. undefined or
      // "main" means the main-agent compaction; any other value is a subagent
      // slice. Subscribers that only care about the main context (e.g. the
      // cron-bridge sentinel cache) can filter on this.
      agentID: z.string().optional(),
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
export const COMPACTION_TAIL_BUDGET = 40_000
export const COMPACTION_TOOL_RESULT_LIMIT = 8_000
const FILE_MANIFEST_LIMIT = 5
const TAIL_SHRINK_METADATA = "compaction_tail_shrunk_tokens"

type CompactionTrigger = "manual" | "automatic" | "provider-overflow"

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function relativeFile(file: string, worktree: string) {
  return (path.isAbsolute(file) ? path.relative(worktree, file) : file).replaceAll("\\", "/")
}

function xmlText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function readLabel(part: MessageV2.ToolPart) {
  if (part.state.status !== "completed") return "read"
  const offset = number(part.state.input.offset) ?? 1
  const range = part.state.output.match(/Showing lines (\d+)-(\d+)/)
  const contentEnd = Array.from(part.state.output.matchAll(/(?:^|\n)(\d+):/g)).at(-1)?.[1]
  const end = range?.[2] ?? contentEnd
  if (offset === 1 && part.state.metadata.truncated !== true && (part.state.output.includes("(End of file") || !end))
    return "read: full"
  return end ? `read: lines ${offset}-${end}` : `read: from line ${offset}`
}

export function buildFileManifest(messages: MessageV2.WithParts[], env: { worktree: string }) {
  const touched = new Map<string, { path: string; events: string[] }>()
  const add = (file: string | undefined, event: string) => {
    if (!file) return undefined
    const normalized = relativeFile(file, env.worktree)
    if (!normalized) return undefined
    const current = touched.get(normalized) ?? { path: normalized, events: [] }
    if (current.events.at(-1) !== event) current.events.push(event)
    touched.delete(normalized)
    touched.set(normalized, current)
    return normalized
  }

  for (const message of messages) {
    const mutatedFiles = new Set<string>()
    for (const part of message.parts) {
      if (part.type === "patch") {
        for (const file of part.files) {
          if (mutatedFiles.has(relativeFile(file, env.worktree))) continue
          add(file, "edited")
        }
        continue
      }
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const inputPath =
        string(part.state.input.file_path) ?? string(part.state.input.path) ?? string(part.state.input.notebook_path)
      if (part.tool === "read") {
        add(inputPath, readLabel(part))
        continue
      }
      if (part.tool === "apply_patch" && Array.isArray(part.state.metadata.files)) {
        for (const item of part.state.metadata.files) {
          const file = record(item)
          if (!file) continue
          const normalized = add(
            string(file.relativePath) ?? string(file.filePath),
            file.type === "add" ? "written" : "edited",
          )
          if (normalized) mutatedFiles.add(normalized)
        }
        continue
      }
      if (!["write", "edit", "multiedit", "notebook_edit", "str_replace"].includes(part.tool)) continue
      const metadataPath = string(part.state.metadata.filepath) ?? string(record(part.state.metadata.filediff)?.file)
      const written =
        (part.tool === "write" && part.state.metadata.exists === false) ||
        (part.tool === "edit" && part.state.input.old_string === "")
      const file = add(inputPath ?? metadataPath, written ? "written" : "edited")
      if (file) mutatedFiles.add(file)
    }
  }

  const files = Array.from(touched.values()).slice(-FILE_MANIFEST_LIMIT)
  if (!files.length) return
  return [
    "## Attachments",
    "",
    "<files-touched>",
    "These files were read or edited earlier in this session. Their contents have been",
    "removed from context — re-read any file you need before editing it.",
    "",
    ...files.map((file) => `- ${xmlText(file.path)} (${file.events.slice(-3).join(", then ")})`),
    "</files-touched>",
  ].join("\n")
}

export function groupByApiRound(messages: MessageV2.WithParts[]) {
  return messages.reduce<MessageV2.WithParts[][]>((rounds, message) => {
    if (message.info.role === "user" || rounds.length === 0) {
      rounds.push([message])
      return rounds
    }
    rounds.at(-1)!.push(message)
    return rounds
  }, [])
}

export function shrinkLargeToolResults(messages: MessageV2.WithParts[]) {
  return messages.map(
    (message): MessageV2.WithParts => ({
      info: message.info,
      parts: message.parts.map((part) => {
        if (part.type !== "tool" || part.state.status !== "completed") return part
        const tokens = Token.estimate(part.state.output)
        if (tokens <= COMPACTION_TOOL_RESULT_LIMIT) return part
        return {
          ...part,
          state: {
            ...part.state,
            output: `[Tool result omitted during compaction: ${tokens} tokens. Re-run "${part.tool}" if this result is needed.]`,
            providerOutput: undefined,
            attachments: undefined,
            metadata: { ...part.state.metadata, [TAIL_SHRINK_METADATA]: tokens },
          },
        }
      }),
    }),
  )
}

export const buildTail = Effect.fn("SessionCompaction.buildTail")(function* (input: {
  messages: MessageV2.WithParts[]
  model: Provider.Model
  budget?: number
}) {
  const rounds = groupByApiRound(input.messages)
  const kept: MessageV2.WithParts[][] = []
  let used = 0
  for (let i = rounds.length - 1; i >= 0; i--) {
    const round = shrinkLargeToolResults(rounds[i])
    const cost = Token.estimate(
      JSON.stringify(yield* Effect.promise(() => MessageV2.toModelMessages(round, input.model))),
    )
    if (used + cost > (input.budget ?? COMPACTION_TAIL_BUDGET)) break
    kept.unshift(round)
    used += cost
  }
  return kept.flat()
})

function compactedToolCalls(messages: MessageV2.WithParts[]) {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return []
      const tokens = number(part.state.metadata[TAIL_SHRINK_METADATA])
      return tokens === undefined ? [] : [{ call_id: part.callID, tokens }]
    }),
  )
}

export function buildSummaryMessage(summary: string, trigger: CompactionTrigger, hasTail: boolean) {
  return [
    `<conversation-summary trigger="${trigger}">`,
    "The earlier conversation has been compacted into the summary below.",
    hasTail
      ? "Complete API rounds that arrived while compaction was running follow this summary."
      : "No additional API rounds arrived while compaction was running.",
    "",
    summary.trim(),
    "</conversation-summary>",
  ].join("\n")
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID; agentID?: string }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
    agentID?: string
  }) => Effect.Effect<"continue" | "stop" | "text-repeat">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
    agentID?: string
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Bus.Service
  | Config.Service
  | Session.Service
  | Agent.Service
  | Plugin.Service
  | SessionProcessor.Service
  | Provider.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space.
    // Scoped to (sessionID, agentID): only inspects messages belonging to the
    // given actor — main-agent messages stay untouched when agentID is set.
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: {
      sessionID: SessionID
      agentID?: string
    }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      log.info("pruning", { agentID: input.agentID ?? "main" })

      const msgs = yield* MessageV2.filterCompactedEffect(input.sessionID, { agentID: input.agentID }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)),
      )
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type === "tool")
            if (part.state.status === "completed") {
              if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
              if (part.state.time.compacted) break loop
              const estimate = Token.estimate(part.state.output)
              total += estimate
              if (total > PRUNE_PROTECT) {
                pruned += estimate
                toPrune.push(part)
              }
            }
        }
      }

      log.info("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        log.info("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      agentID?: string
    }) {
      const snapshotLen = input.messages.length
      const parentIdx = input.messages.findLastIndex((m) => m.info.id === input.parentID)
      const parent = parentIdx >= 0 ? input.messages[parentIdx] : undefined
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const promptConfig = yield* session.resolvePrompt({ sessionID: input.sessionID })
      const userMessage = {
        ...parent.info,
        // The compaction agent owns its summarization prompt. The session's
        // extra system prompt is already persisted and will be restored on the
        // replay/next user turn; injecting it here can change the summary task.
        system: undefined,
        systemMode: undefined,
        harness: promptConfig.harness,
      }
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")

      // Reuse the effective conversation before this synthetic boundary without
      // restoring raw history removed by an earlier compaction or checkpoint.
      const scoped = compactionPart
        ? [...MessageV2.filterCompacted([...input.messages.slice(0, parentIdx)].reverse()), parent]
        : input.messages

      let messages = scoped
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = scoped.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = scoped[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction" || p.type === "checkpoint")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = scoped.slice(0, i)
            break
          }
        }
        const hasContent =
          replay &&
          messages.some(
            (m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction" || p.type === "checkpoint"),
          )
        if (!hasContent) {
          replay = undefined
          messages = scoped
        }
      }

      const agent = yield* agents.get("compaction")
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const requestUser = history.findLast(
        (message): message is MessageV2.WithParts & { info: MessageV2.User } => message.info.role === "user",
      )
      if (!requestUser) {
        log.warn("compaction history has no user message", { sessionID: input.sessionID })
        yield* session.removeMessage({ sessionID: input.sessionID, messageID: input.parentID })
        return "stop" as const
      }
      const parentAgent = yield* agents.get(requestUser.info.agent)
      const parentModel = yield* provider.getModel(requestUser.info.model.providerID, requestUser.info.model.modelID)
      const parentSession = yield* session.get(input.sessionID)
      const profileKey = SessionPrefixSnapshot.profileKey({
        providerID: parentModel.providerID,
        modelID: parentModel.id,
        agent: parentAgent.name,
        agentID: requestUser.info.agentID ?? "main",
        harness: promptConfig.harness,
        systemMode: promptConfig.systemMode,
        system: promptConfig.system ?? "",
        permission: Agent.runtimePermission(parentAgent, parentSession.permission),
      })
      const frozen = yield* SessionPrefixSnapshot.get(input.sessionID, profileKey)
      if (!frozen) {
        log.warn("compaction prefix snapshot missing", { sessionID: input.sessionID, profileKey })
      }
      if (frozen && !frozen.tools) {
        log.warn("compaction prefix snapshot missing advertised tools", {
          sessionID: input.sessionID,
          profileKey,
        })
      }
      const model =
        input.overflow && agent.model
          ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
          : parentModel
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const prompt =
        compacting.prompt ??
        [agent.prompt, ...compacting.context]
          .filter((item): item is string => !!item)
          .join("\n\n")
      const msgs = structuredClone(history)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(
        msgs,
        model,
        input.overflow ? { stripMedia: true } : { collapseCheckpointTail: true },
      )
      const ctx = yield* InstanceState.context
      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        agentID: input.agentID ?? undefined,
        mode: "compaction",
        agent: "compaction",
        variant: requestUser.info.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const summaryRequest = {
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt }],
      }
      const result = yield* processor.process({
        user: {
          ...requestUser.info,
          system: promptConfig.system,
          systemMode: promptConfig.systemMode,
          harness: promptConfig.harness,
        },
        agent: parentAgent,
        permission: parentSession.permission,
        sessionID: input.sessionID,
        tools: frozen?.tools ? SessionPrefixSnapshot.restoreTools(frozen.tools) : {},
        activeTools: frozen?.tools?.map((item) => item.name),
        toolChoice: "auto",
        system: [],
        prebuiltSystem: frozen?.system,
        messages: [...modelMessages, summaryRequest],
        mergeTurnContextBeforeLastMessage: true,
        model,
      })

      const rollback = Effect.fn("SessionCompaction.rollback")(function* (message: string) {
        if (!processor.message.error) {
          processor.message.error = new MessageV2.InvalidOutputError({ message }).toObject()
          processor.message.finish = "error"
          yield* session.updateMessage(processor.message)
        }
        yield* session.removeMessage({ sessionID: input.sessionID, messageID: input.parentID })
        return "stop" as const
      })

      if (result === "overflow") {
        processor.message.error = new MessageV2.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : input.overflow
              ? "Session too large to compact - context exceeds model limit even after stripping media"
              : "Session too large to compact - context exceeds model limit at the message boundary",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return yield* rollback("Compaction exceeded the model context limit")
      }

      if (result === "text-repeat") return yield* rollback("Compaction produced repeated text")
      if (result === "stop") return yield* rollback("Compaction failed before producing a summary")
      if (
        !MessageV2.parts(msg.id).some((part) => part.type === "text" && part.text.trim().length > 0)
      )
        return yield* rollback("Compaction produced no usable summary")

      if (compactionPart) {
        const current = yield* session.messages({
          sessionID: input.sessionID,
          agentID: input.agentID ?? "main",
        })
        const arrived = current.slice(snapshotLen).filter((message) => message.info.id !== msg.id)
        const tail = yield* buildTail({
          messages: arrived,
          model: parentModel,
        })
        const summary = MessageV2.parts(msg.id)
          .filter((part): part is MessageV2.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        const trigger: CompactionTrigger = input.overflow ? "provider-overflow" : input.auto ? "automatic" : "manual"
        yield* session.updatePart({
          ...compactionPart,
          projection: {
            version: 1,
            summary_message_id: msg.id,
            summary: buildSummaryMessage(summary, trigger, tail.length > 0),
            manifest: buildFileManifest(history, { worktree: ctx.worktree }),
            trigger,
            tail_start_id: tail.at(0)?.info.id,
            tail_end_id: arrived.at(-1)?.info.id,
            compacted_tool_calls: compactedToolCalls(tail),
          },
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            agentID: input.agentID ?? undefined,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: promptConfig.system,
            systemMode: promptConfig.systemMode,
            harness: promptConfig.harness,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              agentID: input.agentID ?? undefined,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue")
        yield* bus.publish(Event.Compacted, {
          sessionID: input.sessionID,
          ...(input.agentID ? { agentID: input.agentID } : {}),
        })
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
      agentID?: string
    }) {
      // Tag the synthetic boundary message with agent_id so per-actor
      // filterCompactedEffect lookups stop at this row when scoping by the
      // same agent_id (subagent compaction stays inside its own scope).
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agentID: input.agentID ?? undefined,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
      // Boundary-insert path also drops effective context from the model's
      // view — publish Compacted so downstream caches (cron sentinel etc)
      // reset on their side too. Same event shape as processCompaction.
      yield* bus.publish(Event.Compacted, {
        sessionID: input.sessionID,
        ...(input.agentID ? { agentID: input.agentID } : {}),
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  return runPromise((svc) => svc.isOverflow(input))
}

export async function prune(input: { sessionID: SessionID; agentID?: string }) {
  return runPromise((svc) => svc.prune(input))
}

export const create = fn(
  z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
    agentID: z.string().optional(),
  }),
  (input) => runPromise((svc) => svc.create(input)),
)

export * as SessionCompaction from "./compaction"
