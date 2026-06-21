import path from "path"
import os from "os"
import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { classifyAssistantStep } from "./classify"
import { Log } from "../util"
import { SessionRevert } from "./revert"
import * as Session from "./session"
import { Agent } from "../agent/agent"
import { SYSTEM_SPAWNED_AGENT_TYPES } from "@/agent/config"
import { Provider } from "../provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, type ModelMessage, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionPrune } from "./prune"
import { SessionCheckpoint } from "./checkpoint"
import { SessionCompaction } from "./compaction"
import { computeLastMessageInfo } from "./last-message-info"
import { pressureLevel, isOverflow as overflowCheck } from "./overflow"
import { Config } from "@/config"
import { Global } from "@/global"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Plugin } from "../plugin"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import PROMPT_COMPOSE from "../session/prompt/compose.txt"
import {
  RECOVERY_PROMPT_MILD,
  RECOVERY_PROMPT_STRONG,
  TEXT_LOOP_BUFFER_SIZE,
  TEXT_LOOP_TRIGGER_COUNT,
  TEXT_LOOP_MAX_RECOVERY,
  normalizeForLoopDetection,
  detectTextLoop,
} from "../session/prompt/text-loop-recovery"
import {
  TEXT_NGRAM_MAX_RECOVERY,
  TEXT_NGRAM_RECOVERY_REMIND,
  TEXT_NGRAM_RECOVERY_REPLAN,
} from "../session/prompt/text-ngram-detection"
import { composeSkillsBlock } from "@/skill/compose/extract"
import { ToolRegistry } from "../tool"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown } from "../config"
import { SessionSummary } from "./summary"
import { NamedError } from "@mimo-ai/shared/util/error"
import { SessionProcessor } from "./processor"
import { buildLLMRequestPrefix } from "./llm-request-prefix"
import {
  serializeTrajectoryMessages,
  withAssistantParts,
  userQueryText,
  assistantFinalText,
  sessionErrorText,
} from "./trajectory"
import { prefixCaptureRef } from "./prefix-capture-ref"
import { spawnRef } from "@/actor/spawn-ref"
import { Inbox } from "@/inbox"
import { sessionPromptRef } from "@/inbox/inbox-ref"
import { Tool } from "@/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { MaxMode } from "./max-mode"
import { Shell } from "@/shell/shell"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Truncate } from "@/tool"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util"
import { Cause, Effect, Exit, Layer, Option, Scope, Context } from "effect"
import { EffectLogger } from "@/effect"
import { InstanceState } from "@/effect"
import { ActorTool, type ActorPromptOps } from "@/tool/actor"
import { SessionRunState } from "./run-state"
import { Goal } from "./goal"
import { TaskGate, MAX_TASK_GATE_MAIN_REACT } from "@/task/gate"
import { TaskGateState } from "@/task/gate-state"
import { TaskRegistry } from "@/task/registry"
import { EffectBridge } from "@/effect"
import { Team } from "@/team"
import { ActorRegistry } from "@/actor/registry"
import { Metrics } from "@/metrics"
import { resolveInvocationStyle, type ToolStyleConfig } from "../tool/invocation-style"
import { shouldAutoDream, shouldAutoDistill, DREAM_TASK, DISTILL_TASK, AUTO_DREAM_TITLE, AUTO_DISTILL_TITLE } from "./auto-dream"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

// Recall-reminder hints, rendered in each tool's configured invocation style so
// shell-mode sessions never see a JSON-shaped example (which primes models to
// emit JSON and crash the shell parser). `memory` has no shell form, so it is
// always JSON. Exported for unit testing.
export function recallHintLines(toolCfg: ToolStyleConfig | undefined): string[] {
  const taskHint =
    resolveInvocationStyle(toolCfg, "task") === "shell" ? "- task list" : `- task({ operation: "list" })`
  const actorHint =
    resolveInvocationStyle(toolCfg, "actor") === "shell"
      ? "- actor status <actor_id>"
      : `- actor({ operation: "status", actor_id: "<id>" })`
  // memory has no shell form (no shell.parse) → always JSON.
  return [`- memory({ operation: "search", query: "<keyword>" })`, taskHint, actorHint]
}

/**
 * Cap on goal-driven main-loop re-entries per turn — the safety valve against
 * a never-satisfiable condition burning tokens forever. Higher than spawned
 * actors' MAX_PRE_REACT (=3) because main-session goals are usually larger.
 * TODO: lift to mimocode.json config (e.g. session.maxGoalReact).
 */
const MAX_GOAL_REACT = 12

/**
 * Number of consecutive finished assistant steps with an identical action
 * signature that trips the repeated-step nudge. Three in a row is a strong
 * signal the model is stuck repeating itself rather than making progress.
 */
const REPEATED_STEP_THRESHOLD = 3

/**
 * Deterministic JSON serialization with sorted object keys, so that two
 * semantically-identical tool inputs produce the same string regardless of the
 * order the model happened to emit the keys in. `JSON.stringify` preserves
 * insertion order, and models routinely re-emit the same arguments with keys in
 * a different order (e.g. {url,format} vs {format,url}) — without this the
 * signatures would differ and the repeated-step check would miss real loops.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]"
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") +
    "}"
  )
}

/**
 * Stable signature for an assistant step's *action* — the tool calls it made
 * (name + key-order-independent input). Text and reasoning are excluded on
 * purpose: in a ReAct loop the model narrates each step in slightly different
 * words while taking the exact same action, and some models emit their
 * reasoning as plain text parts — counting either would mask the repeated
 * action we want to catch. Returns undefined when a step makes no tool calls
 * (e.g. a pure-text turn), since there is no repeated *action* to compare.
 */
function stepSignature(parts: MessageV2.Part[]): string | undefined {
  const segments: string[] = []
  for (const part of parts) {
    if (part.type === "tool") {
      segments.push("tool:" + part.tool + ":" + stableStringify(part.state.input ?? {}))
    }
  }
  if (segments.length === 0) return undefined
  return segments.join("\n")
}

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

const PREDICT_SYSTEM = `You predict the single most likely next message a user will send to a coding assistant, based on the conversation so far. Output only that next message as one short, natural first-person request (what the user would type). No preamble, no quotes, no explanation, no markdown. Keep it under 100 characters.`

const PREDICT_NUDGE = `Based on the conversation above, write the user's most likely next message:`

const OUTPUT_LENGTH_CONTINUATION_LIMIT = Flag.MIMOCODE_OUTPUT_LENGTH_CONTINUATION_LIMIT
const INVALID_OUTPUT_CONTINUATION_LIMIT = Flag.MIMOCODE_INVALID_OUTPUT_CONTINUATION_LIMIT

const log = Log.create({ service: "session.prompt" })

function isExtensionPath(filePath: string): boolean {
  return /\/\.mimocode\/(tools?|skills?|hooks?)\//.test(filePath)
}
const elog = EffectLogger.create({ service: "session.prompt" })

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>
  readonly loop: (input: z.infer<typeof LoopInput>) => Effect.Effect<MessageV2.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts>
  readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  readonly sweepOrphanAssistants: (sessionID: SessionID) => Effect.Effect<void>
  readonly predict: (input: { sessionID: SessionID }) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const prune = yield* SessionPrune.Service
    const checkpoint = yield* SessionCheckpoint.Service
    const compaction = yield* SessionCompaction.Service
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const permission = yield* Permission.Service
    const fsys = yield* AppFileSystem.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const goal = yield* Goal.Service
    const taskGateState = yield* TaskGateState.Service
    const taskRegistry = yield* TaskRegistry.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const actorRegistry = yield* ActorRegistry.Service
    const inbox = yield* Inbox.Service

    // Track sessions that have already shown the "loaded instructions" toast so we
    // surface it once per primary session rather than on every run-loop turn.
    const instructionsNotified = new Set<SessionID>()

    // Late-bind prefix-capture helper so SessionCheckpoint.tryStartCheckpointWriter
    // can call buildLLMRequestPrefix without forming a layer cycle
    // (ToolRegistry → SessionCheckpoint → ToolRegistry). See prefix-capture-ref.ts.
    // The closure resolves Agent.Info and Provider.Model internally so checkpoint.ts
    // only needs to pass string IDs.
    const capture: typeof prefixCaptureRef.current = (input) =>
      Effect.gen(function* () {
        const empty = { system: [] as string[], tools: {} as Record<string, AITool>, inheritedMessages: [] as ModelMessage[], parentPermission: [] as Permission.Ruleset }
        const ag = yield* agents.get(input.agentName).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!ag) return empty
        const model = yield* provider
          .getModel(input.providerID as ProviderID, input.modelID as ModelID)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!model) return empty
        // Anchor the env date to the session's creation time so the captured prefix is
        // byte-identical to the runLoop's (which uses session.time.created), preserving
        // Anthropic cache parity. If the session can't be loaded we can't guarantee that
        // parity, so fall through to empty rather than emit a divergent date.
        const captureSession = yield* sessions.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!captureSession) return empty
        const [skills, env, instructions] = yield* Effect.all([
          sys.skills(ag),
          Effect.sync(() => sys.environment(model, captureSession.time.created)),
          instruction.system().pipe(Effect.orDie),
        ])
        // (checkpoint-writer never requests json_schema output, so STRUCTURED_OUTPUT_SYSTEM_PROMPT
        // is not included; parent's runLoop adds it conditionally based on user.format)
        const additions = [...env, ...(skills ? [skills] : []), ...instructions.content]
        const prefix = yield* buildLLMRequestPrefix({
          sessionID: input.sessionID,
          agent: ag,
          model,
          msgs: input.msgs as Parameters<typeof buildLLMRequestPrefix>[0]["msgs"],
          additions,
        }).pipe(
          Effect.provideService(LLM.Service, llm),
          Effect.provideService(ToolRegistry.Service, registry),
          Effect.catch(() => Effect.succeed(empty)),
        )
        return { ...prefix, parentPermission: ag.permission }
      })
    prefixCaptureRef.current = capture
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (prefixCaptureRef.current === capture) prefixCaptureRef.current = undefined
      }),
    )

    const runner = Effect.fn("SessionPrompt.runner")(function* () {
      return yield* EffectBridge.make()
    })
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      const run = yield* runner()
      return {
        cancel: (sessionID: SessionID) => run.fork(cancel(sessionID)),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input),
      } satisfies ActorPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* elog.info("cancel", { sessionID })
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: PromptInput["parts"] = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (seen.has(name)) return
          seen.add(name)
          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: MessageV2.WithParts[]
      providerID: ProviderID
      modelID: ModelID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: MessageV2.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.modelRef
        ? yield* provider.resolveModelRef(ag.modelRef, input.providerID)
        : ag.model
          ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
          : ((yield* provider.getSmallModel(input.providerID)) ??
            (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter((e): e is Extract<LLM.Event, { type: "text-delta" }> => e.type === "text-delta"),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => elog.error("failed to generate title", { error: Cause.squash(cause) })))
    })

    const predict = Effect.fn("SessionPrompt.predict")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (cfg.experimental?.predict_next_prompt === false) return ""

      const history = yield* sessions.messages({ sessionID: input.sessionID, agentID: "main" })
      const real = (m: MessageV2.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const userIdx = history.findLastIndex(real)
      if (userIdx === -1) return ""
      const lastUser = history[userIdx]
      if (lastUser.info.role !== "user") return ""

      // Only the assistant turn that actually answered this user message counts.
      // Bail if that turn is still running (an incomplete assistant after it),
      // so we never pair the newest prompt with a stale/older result.
      const assistants = history
        .slice(userIdx + 1)
        .filter((m): m is MessageV2.WithParts & { info: MessageV2.Assistant } => m.info.role === "assistant")
      if (assistants.length === 0) return ""
      if (assistants.some((m) => m.info.time.completed === undefined)) return ""
      const lastAssistant = assistants[assistants.length - 1]

      const base = yield* agents.get("title")
      if (!base) return ""
      // Reuse the lightweight title agent's settings but swap its prompt for the
      // prediction prompt — its default ("output ONLY a thread title") would
      // otherwise be prepended ahead of PREDICT_SYSTEM and win.
      const ag = { ...base, prompt: PREDICT_SYSTEM }
      const mdl = ag.modelRef
        ? yield* provider.resolveModelRef(ag.modelRef, lastAssistant.info.providerID)
        : ag.model
          ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
          : ((yield* provider.getSmallModel(lastAssistant.info.providerID)) ??
            (yield* provider.getModel(lastAssistant.info.providerID, lastAssistant.info.modelID)))

      const msgs = yield* MessageV2.toModelMessagesEffect([lastUser, lastAssistant], mdl, { stripMedia: true })
      const text = yield* llm
        .stream({
          agent: ag,
          user: lastUser.info,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.sessionID,
          retries: 1,
          messages: [...msgs, { role: "user", content: PREDICT_NUDGE }],
        })
        .pipe(
          Stream.filter((e): e is Extract<LLM.Event, { type: "text-delta" }> => e.type === "text-delta"),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orElseSucceed(() => ""),
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return ""
      const stripped = cleaned.replace(quoteTrimRegex, "")
      return stripped.length > 120 ? stripped.substring(0, 117) + "..." : stripped
    })

    const insertReminders = Effect.fn("SessionPrompt.insertReminders")(function* (input: {
      messages: MessageV2.WithParts[]
      agent: Agent.Info
      session: Session.Info
    }) {
      const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
      if (!userMessage) return input.messages

      const composeModeMsg = input.messages.find(
        (msg) => msg.info.role === "user" && msg.info.agent === "compose",
      )
      if (composeModeMsg) {
        const composeModeBlock = composeSkillsBlock()
        composeModeMsg.parts.unshift({
          id: PartID.ascending(),
          messageID: composeModeMsg.info.id,
          sessionID: composeModeMsg.info.sessionID,
          type: "text",
          text: PROMPT_COMPOSE + (composeModeBlock ? "\n\n" + composeModeBlock : ""),
          synthetic: true,
        })
      }

      const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
      if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
        const plan = Session.plan(input.session)
        if (!(yield* fsys.existsSafe(plan))) return input.messages
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
        return input.messages
      }

      if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

      const plan = Session.plan(input.session)
      const exists = yield* fsys.existsSafe(plan)
      if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
 - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
 - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
 - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
 - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    })

    const resolveTools = Effect.fn("SessionPrompt.resolveTools")(function* (input: {
      agent: Agent.Info
      model: Provider.Model
      session: Session.Info
      tools?: Record<string, boolean>
      processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
      bypassAgentCheck: boolean
      messages: MessageV2.WithParts[]
      agentID?: string
      task_id?: string
    }) {
      using _ = log.time("resolveTools")
      const tools: Record<string, AITool> = {}
      const run = yield* runner()
      const promptOps = yield* ops()

      // Per-tool runtime whitelist: when the LLM call is being made on behalf
      // of a registered actor (subagent or peer), look up the actor row and,
      // if `actor.tools` is an array, reject calls to tools not in the
      // whitelist. `INHERIT` and a missing actor row both mean full access.
      const whitelistFor = Effect.fn("SessionPrompt.whitelistFor")(function* () {
        if (!input.agentID) return undefined
        const actor = yield* actorRegistry.get(input.session.id, input.agentID)
        if (!actor || !Array.isArray(actor.tools)) return undefined
        return new Set(actor.tools)
      })
      const whitelist = yield* whitelistFor()
      const rejectionFor = (toolID: string) => ({
        title: "Tool not permitted",
        output: `The "${toolID}" tool is not in this actor's whitelist. Allowed tools: ${
          whitelist ? [...whitelist].join(", ") : "(none)"
        }.`,
        metadata: { rejected: true, reason: "tool-whitelist" as const },
      })

      const context = (args: any, options: ToolExecutionOptions): Tool.Context => ({
        sessionID: input.session.id,
        abort: options.abortSignal!,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps },
        agent: input.agent.name,
        actorID: input.agentID,
        taskId: input.task_id,
        messages: input.messages,
        metadata: (val) =>
          input.processor.updateToolCall(options.toolCallId, (match) => {
            if (!["running", "pending"].includes(match.state.status)) return match
            return {
              ...match,
              state: {
                title: val.title,
                metadata: val.metadata,
                status: "running",
                input: args,
                time: { start: Date.now() },
              },
            }
          }),
        ask: (req) =>
          permission
            .ask(
              {
                ...req,
                sessionID: input.session.id,
                tool: { messageID: input.processor.message.id, callID: options.toolCallId },
                ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
                // System-spawned background agents (checkpoint-writer, dream, distill)
                // have no human to answer a permission prompt — fail clean, don't hang.
                interactive: !SYSTEM_SPAWNED_AGENT_TYPES.has(input.agent.name),
              },
              options.abortSignal,
            )
            .pipe(Effect.orDie),
      })

      for (const item of yield* registry.tools({
        modelID: ModelID.make(input.model.api.id),
        providerID: input.model.providerID,
        agent: input.agent,
      })) {
        const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
        tools[item.id] = tool({
          description: item.description,
          inputSchema: jsonSchema(schema),
          execute(args, options) {
            return run.promise(
              Effect.gen(function* () {
                const startTs = Date.now()
                const callID = options?.toolCallId ?? "?"
                log.debug("tool execute start", {
                  tool: item.id,
                  callID,
                  sessionID: input.session.id,
                })
                const ctx = context(args, options)
                if (whitelist && !whitelist.has(item.id)) {
                  const output = rejectionFor(item.id)
                  log.debug("tool execute rejected", {
                    tool: item.id,
                    callID,
                    durationMs: Date.now() - startTs,
                  })
                  yield* input.processor.completeToolCall(options.toolCallId, output)
                  return output
                }
                const beforeOutput: { args: any; cancel?: boolean; cancelReason?: string } = { args }
                yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                  beforeOutput,
                )
                if (beforeOutput.cancel) {
                  const cancelOutput = {
                    title: "Cancelled",
                    output: beforeOutput.cancelReason || "Tool call cancelled by hook",
                    metadata: { cancelled: true },
                  }
                  yield* bus
                    .publish(Metrics.ToolCall, {
                      sessionID: ctx.sessionID,
                      tool_name: item.id,
                      input_bytes: Metrics.jsonByteLength(beforeOutput.args),
                      output_bytes: 0,
                      tool_call_id: options.toolCallId,
                      tool_call_status: "cancelled",
                    })
                    .pipe(Effect.ignore)
                  yield* input.processor.completeToolCall(options.toolCallId, cancelOutput)
                  return cancelOutput
                }
                const result = yield* item.execute(beforeOutput.args, ctx)
                log.debug("tool execute done", {
                  tool: item.id,
                  callID,
                  durationMs: Date.now() - startTs,
                  ok: true,
                })
                const output = {
                  ...result,
                  attachments: result.attachments?.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: input.processor.message.id,
                  })),
                }
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args: beforeOutput.args },
                  output,
                )
                if (
                  (item.id === "write" || item.id === "edit") &&
                  beforeOutput.args?.filePath &&
                  isExtensionPath(beforeOutput.args.filePath)
                ) {
                  yield* registry.reload().pipe(Effect.tapError((err) => Effect.sync(() => log.warn("extension reload failed", { error: err }))), Effect.ignore)
                }
                yield* bus
                  .publish(Metrics.ToolCall, {
                    sessionID: ctx.sessionID,
                    tool_name: item.id,
                    input_bytes: Metrics.jsonByteLength(beforeOutput.args),
                    output_bytes: Buffer.byteLength(output.output ?? "", "utf8"),
                    tool_call_id: options.toolCallId,
                    tool_call_status: "success",
                  })
                  .pipe(Effect.ignore)
                if (options.abortSignal?.aborted) {
                  yield* input.processor.completeToolCall(options.toolCallId, output)
                }
                return output
              }),
            )
          },
        })
      }

      for (const [key, item] of Object.entries(yield* mcp.tools())) {
        const execute = item.execute
        if (!execute) continue

        const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
        const transformed = ProviderTransform.schema(input.model, schema)
        item.inputSchema = jsonSchema(transformed)
        item.execute = (args, opts) =>
          run.promise(
            Effect.gen(function* () {
              const startTs = Date.now()
              const callID = opts?.toolCallId ?? "?"
              log.debug("tool execute start (mcp)", {
                tool: key,
                callID,
                sessionID: input.session.id,
              })
              const ctx = context(args, opts)
              if (whitelist && !whitelist.has(key)) {
                const rejection = rejectionFor(key)
                const output = {
                  title: rejection.title,
                  metadata: rejection.metadata,
                  output: rejection.output,
                  attachments: [],
                  content: [{ type: "text" as const, text: rejection.output }],
                }
                log.debug("tool execute rejected (mcp)", {
                  tool: key,
                  callID,
                  durationMs: Date.now() - startTs,
                })
                yield* input.processor.completeToolCall(opts.toolCallId, output)
                return output
              }
              const mcpBeforeOutput: { args: any; cancel?: boolean; cancelReason?: string } = { args }
              yield* plugin.trigger(
                "tool.execute.before",
                { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
                mcpBeforeOutput,
              )
              if (mcpBeforeOutput.cancel) {
                const cancelResult = {
                  content: [{ type: "text" as const, text: mcpBeforeOutput.cancelReason || "Tool call cancelled by hook" }],
                }
                yield* bus
                  .publish(Metrics.ToolCall, {
                    sessionID: ctx.sessionID,
                    tool_name: key,
                    input_bytes: Metrics.jsonByteLength(mcpBeforeOutput.args),
                    output_bytes: 0,
                    tool_call_id: opts.toolCallId,
                    tool_call_status: "cancelled",
                  })
                  .pipe(Effect.ignore)
                return cancelResult
              }
              yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
              const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.promise(() =>
                execute(mcpBeforeOutput.args, opts),
              )
              log.debug("tool execute done (mcp)", {
                tool: key,
                callID,
                durationMs: Date.now() - startTs,
                ok: true,
              })
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
                result,
              )

              const textParts: string[] = []
              yield* bus
                .publish(Metrics.ToolCall, {
                  sessionID: ctx.sessionID,
                  tool_name: key,
                  input_bytes: Metrics.jsonByteLength(args),
                  output_bytes: Metrics.jsonByteLength(result.content ?? ""),
                  tool_call_id: opts.toolCallId,
                  tool_call_status: "success",
                })
                .pipe(Effect.ignore)
              const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
              for (const contentItem of result.content) {
                if (contentItem.type === "text") textParts.push(contentItem.text)
                else if (contentItem.type === "image") {
                  attachments.push({
                    type: "file",
                    mime: contentItem.mimeType,
                    url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
                  })
                } else if (contentItem.type === "resource") {
                  const { resource } = contentItem
                  if (resource.text) textParts.push(resource.text)
                  if (resource.blob) {
                    attachments.push({
                      type: "file",
                      mime: resource.mimeType ?? "application/octet-stream",
                      url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                      filename: resource.uri,
                    })
                  }
                }
              }

              const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
              const metadata = {
                ...result.metadata,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              }

              const output = {
                title: "",
                metadata,
                output: truncated.content,
                attachments: attachments.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
                content: result.content,
              }
              if (opts.abortSignal?.aborted) {
                yield* input.processor.completeToolCall(opts.toolCallId, output)
              }
              return output
            }),
          )
        tools[key] = item
      }

      return tools
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: MessageV2.SubtaskPart
      model: Provider.Model
      lastUser: MessageV2.User
      sessionID: SessionID
      session: Session.Info
      msgs: MessageV2.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { actor: actorTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: MessageV2.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        agentID: lastUser.agentID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      const taskArgs = {
        operation: {
          action: "run" as const,
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
        },
      }
      let part: MessageV2.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: ActorTool.id,
        state: {
          status: "running",
          input: taskArgs,
          time: { start: Date.now() },
        },
      })
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: ActorTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* actorTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies MessageV2.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
            return Effect.void
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies MessageV2.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: ActorTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        agentID: lastUser.agentID,
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the actor tool output above and continue with your task.",
        synthetic: true,
      } satisfies MessageV2.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput) {
      const ctx = yield* InstanceState.context
      const run = yield* runner()
      const session = yield* sessions.get(input.sessionID)
      if (session.revert) {
        yield* revert.cleanup(session)
      }
      const agent = yield* agents.get(input.agent)
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const inputModel = input.modelRef
        ? yield* provider
            .resolveModelRef(input.modelRef)
            .pipe(Effect.map((m) => ({ providerID: m.providerID, modelID: m.id })))
        : input.model
      const agentModel = agent.modelRef
        ? yield* provider
            .resolveModelRef(agent.modelRef)
            .pipe(Effect.map((m) => ({ providerID: m.providerID, modelID: m.id })))
        : agent.model
      const model = inputModel ?? agentModel ?? (yield* lastModel(input.sessionID))
      const userMsg: MessageV2.User = {
        id: input.messageID ?? MessageID.ascending(),
        sessionID: input.sessionID,
        time: { created: Date.now() },
        role: "user",
        agent: input.agent,
        model: { providerID: model.providerID, modelID: model.modelID },
      }
      yield* sessions.updateMessage(userMsg)
      const userPart: MessageV2.Part = {
        type: "text",
        id: PartID.ascending(),
        messageID: userMsg.id,
        sessionID: input.sessionID,
        text: "The following tool was executed by the user",
        synthetic: true,
      }
      yield* sessions.updatePart(userPart)

      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        parentID: userMsg.id,
        agentID: userMsg.agentID,
        mode: input.agent,
        agent: input.agent,
        cost: 0,
        path: { cwd: ctx.directory, root: ctx.worktree },
        time: { created: Date.now() },
        role: "assistant",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
      }
      yield* sessions.updateMessage(msg)
      const part: MessageV2.ToolPart = {
        type: "tool",
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: input.sessionID,
        tool: "bash",
        callID: ulid(),
        state: {
          status: "running",
          time: { start: Date.now() },
          input: { command: input.command },
        },
      }
      yield* sessions.updatePart(part)

      const sh = Shell.preferred()
      const shellName = (
        process.platform === "win32" ? path.win32.basename(sh, ".exe") : path.basename(sh)
      ).toLowerCase()
      const invocations: Record<string, { args: string[] }> = {
        nu: { args: ["-c", input.command] },
        fish: { args: ["-c", input.command] },
        zsh: {
          args: [
            "-l",
            "-c",
            `
              __oc_cwd=$PWD
              [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
              [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
              cd "$__oc_cwd"
              eval ${JSON.stringify(input.command)}
            `,
          ],
        },
        bash: {
          args: [
            "-l",
            "-c",
            `
              __oc_cwd=$PWD
              shopt -s expand_aliases
              [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
              cd "$__oc_cwd"
              eval ${JSON.stringify(input.command)}
            `,
          ],
        },
        cmd: { args: ["/c", input.command] },
        powershell: { args: ["-NoProfile", "-Command", input.command] },
        pwsh: { args: ["-NoProfile", "-Command", input.command] },
        "": { args: ["-c", input.command] },
      }

      const args = (invocations[shellName] ?? invocations[""]).args
      const cwd = ctx.directory
      const shellEnv = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: input.sessionID, callID: part.callID },
        { env: {} },
      )

      const cmd = ChildProcess.make(sh, args, {
        cwd,
        extendEnv: true,
        env: { ...shellEnv.env, TERM: "dumb" },
        stdin: "ignore",
        forceKillAfter: "3 seconds",
      })

      let output = ""
      let aborted = false

      const finish = Effect.uninterruptible(
        Effect.gen(function* () {
          if (aborted) {
            output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
          }
          if (!msg.time.completed) {
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          }
          if (part.state.status === "running") {
            part.state = {
              status: "completed",
              time: { ...part.state.time, end: Date.now() },
              input: part.state.input,
              title: "",
              metadata: { output, description: "" },
              output,
            }
            yield* sessions.updatePart(part)
          }
        }),
      )

      const exit = yield* Effect.gen(function* () {
        const handle = yield* spawner.spawn(cmd)
        yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
          Effect.sync(() => {
            output += chunk
            if (part.state.status === "running") {
              part.state.metadata = { output, description: "" }
              void run.fork(sessions.updatePart(part))
            }
          }),
        )
        yield* handle.exitCode
      }).pipe(
        Effect.scoped,
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            aborted = true
          }),
        ),
        Effect.orDie,
        Effect.ensuring(finish),
        Effect.exit,
      )

      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.failCause(exit.cause)
      }

      return { info: msg, parts: [part] }
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderID,
      modelID: ModelID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.data.suggestions?.length ? ` Did you mean: ${err.data.suggestions.join(", ")}?` : ""
        yield* bus.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.data.providerID}/${err.data.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.failCause(exit.cause)
    })

    const lastModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(
        sessionID,
        (m) => m.info.role === "user" && !!m.info.model,
        { agentID: "*" },
      )
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel()
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent || (yield* agents.defaultAgent())
      const ag = yield* agents.get(agentName)
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const inputModel = input.modelRef
        ? yield* provider
            .resolveModelRef(input.modelRef)
            .pipe(Effect.map((m) => ({ providerID: m.providerID, modelID: m.id })))
        : input.model
      const agentModel = ag.modelRef
        ? yield* provider
            .resolveModelRef(ag.modelRef)
            .pipe(Effect.map((m) => ({ providerID: m.providerID, modelID: m.id })))
        : ag.model
      const model = inputModel ?? agentModel ?? (yield* lastModel(input.sessionID))
      const same = agentModel && model.providerID === agentModel.providerID && model.modelID === agentModel.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.catchDefect(() => Effect.void))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: MessageV2.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        agentID: input.agentID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
        provenance: input.provenance,
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<MessageV2.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if ("text" in c && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && c.blob) {
                  const mime = "mimeType" in c ? c.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mime}]`,
                  })
                }
              }
              pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
            } else {
              const error = Cause.squash(exit.cause)
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              log.info("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              if (yield* fsys.isDir(filepath)) part.mime = "application/x-directory"

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read directory", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${part.mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the actor tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const parts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts },
      )

      const parsed = MessageV2.Info.safeParse(info)
      if (!parsed.success) {
        log.error("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          issues: parsed.error.issues,
        })
      }
      parts.forEach((part, index) => {
        const p = MessageV2.Part.safeParse(part)
        if (p.success) return
        log.error("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          issues: p.error.issues,
          part,
        })
      })

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const sweepOrphanAssistants = Effect.fn("SessionPrompt.sweepOrphanAssistants")(function* (sessionID: SessionID) {
      const msgs = yield* sessions.messages({ sessionID, agentID: "*" })
      const now = Date.now()
      // 1 hour — must exceed Task 1's chunkMs (300s) plus Task 2's
      // PERSISTENT_RETRY worst-case backoff (10 attempts × 5 min cap =
      // 50 min) so a still-active in-flight request is never falsely
      // swept while its retry chain is making progress.
      const ORPHAN_AGE_MS = 3_600_000
      for (const m of msgs) {
        if (m.info.role !== "assistant") continue
        if (m.info.time?.completed) continue
        const created = m.info.time?.created ?? 0
        if (now - created < ORPHAN_AGE_MS) continue
        m.info.time = { ...m.info.time, completed: now }
        m.info.error =
          m.info.error ??
          new MessageV2.AbortedError({
            message: "Abandoned: previous request interrupted before completion",
          }).toObject()
        yield* sessions.updateMessage(m.info).pipe(
          Effect.catchCause((cause) =>
            elog.warn("orphan-update-failed", {
              sessionID,
              messageID: m.info.id,
              cause,
            }),
          ),
        )
        yield* elog.info("orphan-assistant-cleared", {
          sessionID,
          messageID: m.info.id,
        })
      }
    })

    const prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.prompt")(
      function* (input: PromptInput) {
        const session = yield* sessions.get(input.sessionID)
        if (input.source !== "spawn" && input.source !== "hook") {
          yield* revert.cleanup(session)
          yield* sweepOrphanAssistants(input.sessionID)
        }
        const message = yield* createUserMessage(input)
        yield* sessions.touch(input.sessionID)

        const permissions: Permission.Ruleset = []
        for (const [t, enabled] of Object.entries(input.tools ?? {})) {
          permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
        }
        if (permissions.length > 0) {
          session.permission = permissions
          yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
        }

        if (input.noReply === true) return message
        return yield* loop({ sessionID: input.sessionID, agentID: input.agentID ?? "main", task_id: input.task_id })
      },
    )

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID, agentID?: string) {
      if (agentID !== undefined) {
        // Agent-scoped: return THIS agent's newest message (assistant preferred).
        // Critical for concurrent same-session subagents — a session-wide lookup
        // collapses concurrent actors' return values onto whichever finished last.
        // messages() yields oldest-first/newest-last, so findLast picks the newest
        // assistant and the last element is the newest message overall.
        const own = yield* sessions.messages({ sessionID, agentID })
        const lastAsst = own.findLast((m) => m.info.role === "assistant")
        if (lastAsst) return lastAsst
        if (own.length > 0) return own[own.length - 1]
        // fall through to session-wide if this agent has no messages yet
      }
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user", { agentID: "*" })
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1, agentID: "*" })
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const runLoop: (sessionID: SessionID, agentID?: string, task_id?: string) => Effect.Effect<MessageV2.WithParts> = Effect.fn(
      "SessionPrompt.run",
    )(
      function* (sessionID: SessionID, agentID?: string, task_id?: string) {
        const ctx = yield* InstanceState.context
        const slog = elog.with({ sessionID })
        let structured: unknown | undefined
        let step = 0
        const session = yield* sessions.get(sessionID)
        let lastFinishedForPrune: MessageV2.Assistant | undefined
        let lastModelForPrune: Provider.Model | undefined
        let outputLengthContinuations = 0
        // Shared local counter for "model finished but produced nothing usable"
        // (think-only / empty). T04's generic-invalid retries reuse this same
        // counter — do not add a second one. Local to runLoop so a fresh user
        // turn resets it (no cross-message pollution), same as outputLengthContinuations.
        let invalidContinuations = 0
        // structured-output 专用 retry：上限来自 lastUser.format.retryCount（默认 2），
        // 与 invalidContinuations（generic invalid）分离，互不污染。局部于 runLoop，
        // 新一轮用户 turn 自动归零。
        let structuredRetries = 0
        const resolvedAgentID = agentID ?? "main"
        // Tracks plugin-driven cancellation (session.pre OR any session.userQuery.pre)
        // so session.post reports outcome="cancelled" instead of "error".
        let cancelled = false
        let cancelReason: string | undefined

        // Fires session.post exactly once via Effect.onExit on the body below.
        // Without this wrapper any yielded failure inside the while loop (provider
        // error, network error, thrown defect) would skip the hook entirely.
        //
        // Trajectory parity: uses MessageV2.filterCompactedEffect with the session's
        // contextFrom / contextWatermark so compaction boundaries trim history to
        // what the agent actually saw, and child-session parent prefixes are
        // included — matching session.userQuery.post semantics.
        const firePostSession = (exit: Exit.Exit<MessageV2.WithParts, unknown>) =>
          Effect.gen(function* () {
            const sliceMsgs = yield* MessageV2.filterCompactedEffect(sessionID, {
              contextFrom: session.contextFrom,
              contextWatermark: session.contextWatermark,
              agentID: resolvedAgentID,
            }).pipe(Effect.catch(() => Effect.succeed([] as MessageV2.WithParts[])))
            const lastSlice = sliceMsgs.findLast((m) => m.info.role === "assistant")
            const finalAsst =
              lastSlice && lastSlice.info.role === "assistant" ? lastSlice.info : undefined
            const finalParts = lastSlice?.parts ?? []
            const failed = Exit.isFailure(exit)
            const finalIsError = !!finalAsst?.error
            const outcome: "completed" | "error" | "cancelled" = cancelled
              ? "cancelled"
              : failed || finalIsError
                ? "error"
                : "completed"
            const error = cancelled
              ? cancelReason
              : failed
                ? Cause.pretty(exit.cause)
                : finalAsst
                  ? sessionErrorText(finalAsst.error)
                  : undefined
            yield* plugin.trigger(
              "session.post",
              {
                sessionID,
                agentID: resolvedAgentID,
                task_id,
                outcome,
                error,
                finalText: finalAsst ? assistantFinalText(finalAsst, finalParts) : undefined,
                assistantMessageID: finalAsst?.id,
                trajectory: serializeTrajectoryMessages(sliceMsgs),
              },
              {},
            )
          }).pipe(Effect.ignore)

        return yield* Effect.gen(function* () {
          const preSession = { cancel: undefined as boolean | undefined, cancelReason: undefined as string | undefined }
          yield* plugin.trigger(
            "session.pre",
            { sessionID, agentID: resolvedAgentID, task_id },
            preSession,
          )
          if (preSession.cancel) {
            cancelled = true
            cancelReason = preSession.cancelReason
            return yield* Effect.fail(
              new NamedError.Unknown({
                message: preSession.cancelReason ?? "Session cancelled by plugin",
              }),
            )
          }
        const agentMetrics = { tokens_in: 0, tokens_out: 0, files_changed: 0 }
        const trajectoryForStep = (currentMsgs: MessageV2.WithParts[], assistant: MessageV2.Assistant) =>
          serializeTrajectoryMessages(
            withAssistantParts(currentMsgs, assistant, MessageV2.parts(assistant.id)),
          )

        const publishAgentRequest = (phase: string, taskType: string) =>
          bus
            .publish(Metrics.AgentRequest, {
              sessionID,
              phase,
              task_type: taskType,
              surface: Flag.MIMOCODE_CLIENT,
              total_tokens_in: agentMetrics.tokens_in,
              total_tokens_out: agentMetrics.tokens_out,
              files_changed: agentMetrics.files_changed,
              validation_status: "skipped",
            })
            .pipe(Effect.ignore)
        // Trim freed space but `lastFinished.tokens` still reflects pre-trim state.
        // Skip one overflow check so the model can respond on the trimmed context;
        // its new assistant message will carry accurate tokens for the next check.
        let skipOverflowCheck = false

        const textLoopBuffer: string[] = []
        let textLoopRecoveryAttempts = 0
        let textNgramRecoveryAttempts = 0

        // Contract (T05): on finish="length", inject a continuation nudge ONLY for
        // plain text. If any non-providerExecuted client tool part exists we bail
        // (return false) and let classify route the normal tool-observation re-loop.
        // This guarantees "no output-length continuation when a tool is involved" —
        // it does NOT guarantee a stream-time-truncated tool never executed, since
        // the AI SDK runs tools mid-stream before the finish reason is known.
        const autoContinueOutputLength = Effect.fn("SessionPrompt.autoContinueOutputLength")(function* (input: {
          lastUser: MessageV2.User
          assistant: MessageV2.Assistant
        }) {
          if (input.assistant.finish !== "length" || input.assistant.error || input.assistant.summary) return false
          if (
            MessageV2.parts(input.assistant.id).some((part) => part.type === "tool" && !part.metadata?.providerExecuted)
          ) {
            return false
          }
          if (outputLengthContinuations >= OUTPUT_LENGTH_CONTINUATION_LIMIT) {
            input.assistant.error = new MessageV2.OutputLengthError({}).toObject()
            yield* sessions.updateMessage(input.assistant)
            yield* bus.publish(Session.Event.Error, {
              sessionID: input.assistant.sessionID,
              error: input.assistant.error,
            })
            return false
          }

          outputLengthContinuations++
          yield* slog.info("auto-continuing output length", { attempt: outputLengthContinuations })
          const msg = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user" as const,
            sessionID: input.lastUser.sessionID,
            agentID: input.lastUser.agentID,
            agent: input.lastUser.agent,
            model: input.lastUser.model,
            tools: input.lastUser.tools,
            format: input.lastUser.format,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: msg.sessionID,
            type: "text",
            synthetic: true,
            text: [
              "<system-reminder>",
              "The previous assistant response hit the model output token limit before completing.",
              "Continue the same task from the exact point where it stopped.",
              "Do not restart, recap, or repeat prior reasoning. Keep reasoning concise, prefer concrete tool calls or final output, and only stop when the user's task is complete or genuinely blocked.",
              "</system-reminder>",
            ].join("\n"),
          } satisfies MessageV2.TextPart)
          return true
        })

        // Task stop-condition gate (main agent only). Before honoring a stop,
        // list non-terminal tasks in the session: if any remain, inject a
        // nudge as a synthetic user turn and re-enter (return true) so the
        // model closes them with `task done` / `task abandon`. ReAct cap +
        // counter mirror the goal gate; cap-exceeded allows stop with a
        // warn log (no reportedStatus on main). owner=undefined picks up
        // tasks orphaned by subagent gates that hit their own cap. Runs
        // BEFORE goalGate because task state is cheaper to settle and a
        // pending-task board pollutes any goal verdict.
        const taskGate = Effect.fn("SessionPrompt.taskGate")(function* (lastUser: MessageV2.User) {
          if ((agentID ?? "main") !== "main") return false
          // If the main agent has the `task` tool stripped (Permission.disabled),
          // a nudge to call `task done` is unsatisfiable and would re-loop to
          // cap. Skip the gate entirely. Mirrors the canWrite skip in
          // actor/spawn.ts (Permission.disabled(["write"], ...) check on
          // forkAgentInfo). Per-session resolution means this checks the
          // agent's static permission only (good enough for v1; session-
          // level overrides re-enabling task on a denied agent are
          // pathological and out of scope).
          const mainAgent = yield* agents.get("main").pipe(Effect.orElseSucceed(() => undefined))
          if (mainAgent && Permission.disabled(["task"], mainAgent.permission).has("task")) return false
          // Per-message `tools` is the second tool-strip layer (llm.ts:720
          // `input.user.tools?.[k] !== false` filter), separate from
          // Permission.disabled. A slash command pinning a narrow toolset for
          // its turn can drop `task` even when permission allows it; nudging
          // is then unsatisfiable. Same skip rationale, narrower window.
          if (lastUser.tools?.["task"] === false) return false

          const count = yield* taskGateState.get(sessionID)
          // runLoop is annotated `R = never`; TaskGate.decide raises a
          // TaskRegistry.Service requirement that we close locally with the
          // layer-resolved binding so it doesn't leak into runLoop's R-set.
          const decision = yield* TaskGate.decide({
            session_id: sessionID,
            owner: undefined,
            reactCount: count,
            maxReact: MAX_TASK_GATE_MAIN_REACT,
            mode: "main",
          }).pipe(Effect.provideService(TaskRegistry.Service, taskRegistry))
          if (!decision.needReentry) {
            if (decision.capExceeded) {
              yield* slog.warn("task gate hit cap; allowing stop", {
                sessionID,
                incompleteTasks: decision.incompleteTasks,
              })
            }
            yield* taskGateState.clear(sessionID)
            return false
          }
          yield* taskGateState.bump(sessionID)
          const reentry = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user" as const,
            sessionID,
            agentID: lastUser.agentID,
            agent: lastUser.agent,
            model: lastUser.model,
            tools: lastUser.tools,
            format: lastUser.format,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reentry.id,
            sessionID,
            type: "text",
            synthetic: true,
            text: decision.reentryText,
          } satisfies MessageV2.TextPart)
          return true
        })

        // Goal stop-condition gate (main agent only). Before honoring a stop,
        // an independent judge model reads the transcript and decides whether
        // the active goal is satisfied. Not satisfied → inject the judge's
        // reason as a synthetic user turn and signal the caller to keep working
        // (return true). This is the main-loop analogue of actor.preStop ReAct
        // re-entry, which only fires for spawned actors. fail-open on any judge
        // error so a flaky judge can never trap the user.
        const goalGate = Effect.fn("SessionPrompt.goalGate")(function* (lastUser: MessageV2.User) {
          if ((agentID ?? "main") !== "main") return false
          const active = yield* goal.get(sessionID)
          if (!active) return false

          const transcriptMsgs = yield* MessageV2.filterCompactedEffect(sessionID, {
            contextFrom: session.contextFrom,
            contextWatermark: session.contextWatermark,
            agentID: "main",
          })
          // Anchor the verdict to the assistant turn the judge just evaluated, so
          // the TUI can render a per-turn marker the user can trace back to.
          const judgedMessageID = transcriptMsgs.findLast((m) => m.info.role === "assistant")?.info.id
          const verdict = yield* goal
            .evaluate({
              condition: active.condition,
              msgs: transcriptMsgs,
              model: lastUser.model,
            })
            .pipe(
              Effect.catch((err) =>
                Effect.gen(function* () {
                  yield* slog.warn("goal judge failed; allowing stop", { error: String(err) })
                  return { ok: true, reason: "judge error", judgeFailed: true } as Goal.Verdict & {
                    judgeFailed: true
                  }
                }),
              ),
            )

          if (verdict.ok || verdict.impossible) {
            yield* slog.info("goal satisfied; allowing stop", {
              sessionID,
              impossible: verdict.impossible === true,
            })
            // Publish the final verdict (goal cleared) so the TUI can render the
            // ✓/⊘ result line before the indicator disappears. goal.clear also
            // publishes goal:undefined, but the TUI keeps lastVerdict sticky.
            yield* bus.publish(Goal.Event.Updated, {
              sessionID,
              goal: undefined,
              lastVerdict: {
                ...verdict,
                attempt: active.react,
                messageID: judgedMessageID,
                error: "judgeFailed" in verdict ? true : undefined,
              },
            })
            yield* goal.clear(sessionID)
            return false
          }

          const count = yield* goal.bumpReact(sessionID)
          if (count > MAX_GOAL_REACT) {
            yield* slog.warn("goal hit MAX_GOAL_REACT cap; allowing stop", {
              sessionID,
              condition: active.condition,
              count,
            })
            yield* bus.publish(Goal.Event.Updated, {
              sessionID,
              goal: undefined,
              lastVerdict: { ...verdict, attempt: count, messageID: judgedMessageID },
            })
            yield* goal.clear(sessionID)
            return false
          }

          yield* slog.info("goal not satisfied; re-entering", { sessionID, attempt: count })
          yield* bus.publish(Goal.Event.Updated, {
            sessionID,
            goal: { condition: active.condition },
            lastVerdict: { ...verdict, attempt: count, messageID: judgedMessageID },
          })
          const reentry = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user" as const,
            sessionID,
            agentID: lastUser.agentID,
            agent: lastUser.agent,
            model: lastUser.model,
            tools: lastUser.tools,
            format: lastUser.format,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reentry.id,
            sessionID,
            type: "text",
            synthetic: true,
            text: [
              "<system-reminder>",
              `Your goal is not yet satisfied: "${active.condition}".`,
              "A judge reviewed the transcript and reported what is still missing:",
              verdict.reason,
              "Keep working toward the goal. Do not stop until it is genuinely met or impossible.",
              "</system-reminder>",
            ].join("\n"),
          } satisfies MessageV2.TextPart)
          return true
        })

        // think-only (reasoning only) / empty (nothing at all) steps finish with
        // a non-tool stop but carry no usable answer. Without intervention the loop
        // breaks and hands the user an assistant with no final text. Nudge the model
        // to produce a final answer or call a real tool; give up (write a terminal
        // error) once the shared counter is exhausted so we never loop forever.
        const autoContinueInvalidOutput = Effect.fn("SessionPrompt.autoContinueInvalidOutput")(function* (input: {
          lastUser: MessageV2.User
          assistant: MessageV2.Assistant
          reason: string
        }) {
          if (input.assistant.error || input.assistant.summary || input.assistant.structured !== undefined) return false
          if (invalidContinuations >= INVALID_OUTPUT_CONTINUATION_LIMIT) {
            input.assistant.error = new MessageV2.InvalidOutputError({ message: input.reason }).toObject()
            yield* sessions.updateMessage(input.assistant)
            yield* bus.publish(Session.Event.Error, {
              sessionID: input.assistant.sessionID,
              error: input.assistant.error,
            })
            return false
          }

          invalidContinuations++
          yield* slog.info("auto-continuing invalid output", { attempt: invalidContinuations, reason: input.reason })
          const msg = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user" as const,
            sessionID: input.lastUser.sessionID,
            agentID: input.lastUser.agentID,
            agent: input.lastUser.agent,
            model: input.lastUser.model,
            tools: input.lastUser.tools,
            format: input.lastUser.format,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: msg.sessionID,
            type: "text",
            synthetic: true,
            text: [
              "<system-reminder>",
              "Your previous response contained no usable answer (it had only reasoning, or was empty).",
              "Provide a final answer to the user now, or call a valid tool to make progress on the task.",
              "Do not respond with only reasoning/thinking.",
              "</system-reminder>",
            ].join("\n"),
          } satisfies MessageV2.TextPart)
          return true
        })

        // json_schema mode but the model never produced structured output (plain
        // text stop, empty, think-only, or any other non-tool terminal). Retry up
        // to lastUser.format.retryCount with a repair nudge; on exhaustion write a
        // StructuredOutputError carrying the *real* retry count. Separate from
        // invalidContinuations: structured retries are bounded by the per-request
        // retryCount, not the generic invalid-output limit.
        const autoRetryStructuredOutput = Effect.fn("SessionPrompt.autoRetryStructuredOutput")(function* (input: {
          lastUser: MessageV2.User
          assistant: MessageV2.Assistant
        }) {
          if (input.assistant.error || input.assistant.summary || input.assistant.structured !== undefined) return false
          const limit = input.lastUser.format?.type === "json_schema" ? input.lastUser.format.retryCount : 0
          if (structuredRetries >= limit) {
            input.assistant.error = new MessageV2.StructuredOutputError({
              message: "Model did not produce structured output",
              retries: structuredRetries,
            }).toObject()
            yield* sessions.updateMessage(input.assistant)
            yield* bus.publish(Session.Event.Error, {
              sessionID: input.assistant.sessionID,
              error: input.assistant.error,
            })
            return false
          }

          structuredRetries++
          yield* slog.info("retrying structured output", { attempt: structuredRetries })
          const msg = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user" as const,
            sessionID: input.lastUser.sessionID,
            agentID: input.lastUser.agentID,
            agent: input.lastUser.agent,
            model: input.lastUser.model,
            tools: input.lastUser.tools,
            // Must carry format so the next iteration re-registers the StructuredOutput tool.
            format: input.lastUser.format,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: msg.sessionID,
            type: "text",
            synthetic: true,
            text: [
              "<system-reminder>",
              "Your previous response did not produce valid structured output via the StructuredOutput tool",
              "(it was plain text, empty, or only reasoning).",
              "You MUST call the StructuredOutput tool now, passing JSON that matches the requested schema.",
              "Do not reply with plain text and do not respond with only reasoning/thinking.",
              "</system-reminder>",
            ].join("\n"),
          } satisfies MessageV2.TextPart)
          return true
        })

        // Sliding-window n-gram repetition recovery. Symmetric across main and
        // fork branches: 1st hit injects REMIND, 2nd hit injects REPLAN, 3rd
        // hit (>= TEXT_NGRAM_MAX_RECOVERY) writes an error and signals break.
        const handleTextRepeat = Effect.fn("SessionPrompt.handleTextRepeat")(function* (input: {
          lastUser: MessageV2.User
        }) {
          if (textNgramRecoveryAttempts >= TEXT_NGRAM_MAX_RECOVERY) {
            yield* slog.info("text n-gram: max recovery exceeded, terminating")
            yield* bus.publish(Session.Event.Error, {
              sessionID,
              error: new NamedError.Unknown({
                message: `Text repetition detected: repeated n-grams after ${TEXT_NGRAM_MAX_RECOVERY} recovery attempts. Session terminated.`,
              }).toObject(),
            })
            return false
          }
          const recoveryText =
            textNgramRecoveryAttempts === 0 ? TEXT_NGRAM_RECOVERY_REMIND : TEXT_NGRAM_RECOVERY_REPLAN
          const reentry = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user" as const,
            sessionID,
            agentID: input.lastUser.agentID,
            agent: input.lastUser.agent,
            model: input.lastUser.model,
            tools: input.lastUser.tools,
            format: input.lastUser.format,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reentry.id,
            sessionID,
            type: "text",
            synthetic: true,
            text: recoveryText,
          } satisfies MessageV2.TextPart)
          textNgramRecoveryAttempts++
          yield* slog.info("text n-gram: recovery injected", { attempt: textNgramRecoveryAttempts })
          return true
        })

        // content-filter is terminal on first occurrence: re-sending the same
        // turn would just get filtered again, so there is no nudge / counter.
        // Write a user-visible error (rendered via the session.error toast) and
        // let the caller break.
        const writeContentFilterError = Effect.fn("SessionPrompt.writeContentFilterError")(function* (input: {
          assistant: MessageV2.Assistant
        }) {
          if (input.assistant.error) return
          input.assistant.error = new MessageV2.ContentFilterError({
            message: "The response was withheld by the model provider's content safety filter.",
          }).toObject()
          yield* sessions.updateMessage(input.assistant)
          yield* bus.publish(Session.Event.Error, {
            sessionID: input.assistant.sessionID,
            error: input.assistant.error,
          })
        })

        // A `failed` classification (model "error" finish, or an error already set
        // by the stream-error path) is terminal. If the step already carries an
        // error (e.g. APIError written when the stream threw, processor.ts:581),
        // keep it; otherwise write a ModelError so the loop never breaks silently
        // without a user-visible failure.
        const writeModelError = Effect.fn("SessionPrompt.writeModelError")(function* (input: {
          assistant: MessageV2.Assistant
          reason: string
        }) {
          if (input.assistant.error) return
          input.assistant.error = new MessageV2.ModelError({ message: input.reason }).toObject()
          yield* sessions.updateMessage(input.assistant)
          yield* bus.publish(Session.Event.Error, {
            sessionID: input.assistant.sessionID,
            error: input.assistant.error,
          })
        })

        while (true) {
          // F55: only main agent sets session status to busy; subagent runners
          // must not touch session-level status (Runner.onBusy is Effect.void
          // for non-main actors per F47).
          if (!agentID || agentID === "main") yield* status.set(sessionID, { type: "busy" })
          yield* inbox.drain(sessionID, agentID ?? "main").pipe(Effect.ignore)
          yield* slog.info("loop", { step })

          // F37: filter by agentID so subagent slices stay isolated from the
          // main agent's slice within the same session. Without this, an actor
          // (explore/general/etc) spawned via mimocode's shared-sessionID
          // design would see the parent's full conversation here and drift
          // off-task. agentID === "main" => main agent slice (agent_id = 'main'
          // in DB), agentID === "explore-1" => only explore-1's slice.
          let msgs = yield* MessageV2.filterCompactedEffect(sessionID, {
            contextFrom: session.contextFrom,
            contextWatermark: session.contextWatermark,
            agentID: agentID ?? "main",
          })

          let lastUser: MessageV2.User | undefined
          let lastAssistant: MessageV2.Assistant | undefined
          let lastFinished: MessageV2.Assistant | undefined
          let tasks: MessageV2.SubtaskPart[] = []
          for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i]
            if (!lastUser && msg.info.role === "user") lastUser = msg.info
            if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info
            if (!lastFinished && msg.info.role === "assistant" && msg.info.finish) lastFinished = msg.info
            if (lastUser && lastFinished) break
            const task = msg.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask")
            if (task && !lastFinished) tasks.push(...task)
          }

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          // Per-user-message active recall reminder. Once the session has
          // any memory artifacts (memory dir populated OR tasks recorded),
          // append a brief recall protocol so the agent's reflex to query
          // memory.search / task / actor / Read stays warm across many
          // post-rebuild turns. Cost ~120 tokens per turn, conditional on
          // hasMemoryOrTasks.
          const lastUserMsgForRecall = msgs.findLast((m) => m.info.role === "user")
          if (lastUserMsgForRecall) {
            const hasRecallTarget = yield* checkpoint
              .hasMemoryOrTasks(sessionID)
              .pipe(Effect.catch(() => Effect.succeed(false)))
            if (hasRecallTarget) {
              const sessMemDir = path.join(Global.Path.data, "memory", "sessions", sessionID)
              const hints = recallHintLines((yield* config.get()).tool)
              lastUserMsgForRecall.parts.push({
                id: PartID.ascending(),
                messageID: lastUserMsgForRecall.info.id,
                sessionID,
                type: "text" as const,
                synthetic: true,
                text: [
                  "<system-reminder>",
                  `This session has memory at ${sessMemDir}/. Recall content`,
                  "not in your context with:",
                  hints[0],
                  `- Read(file_path="${sessMemDir}/...")`,
                  hints[1],
                  hints[2],
                  "",
                  "Don't ask the user about something memory may already record.",
                  "</system-reminder>",
                ].join("\n"),
              })
            }
          }

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" even when the assistant message contains tool calls.
          // Keep the loop running so tool results can be sent back to the model.
          // Skip provider-executed tool parts — those were fully handled within the
          // provider's stream (e.g. DWS Agent Platform) and don't need a re-loop.
          const hasToolCalls =
            lastAssistantMsg?.parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted) ?? false

          if (
            lastAssistant?.finish === "length" &&
            !hasToolCalls &&
            lastUser.id < lastAssistant.id &&
            (yield* autoContinueOutputLength({ lastUser, assistant: lastAssistant }))
          ) {
            continue
          }

          if (lastAssistant) {
            const classification = classifyAssistantStep({
              phase: "existing-assistant",
              lastUser,
              assistant: lastAssistant,
              parts: lastAssistantMsg?.parts ?? [],
            })
            if (classification.type === "filtered") {
              yield* writeContentFilterError({ assistant: lastAssistant })
              yield* slog.info("exiting loop", { classification: classification.type })
              break
            }
            if (classification.type === "failed") {
              yield* writeModelError({ assistant: lastAssistant, reason: classification.reason })
              yield* slog.info("exiting loop", { classification: classification.type, reason: classification.reason })
              break
            }
            if (classification.type === "think-only" || classification.type === "invalid") {
              const reason = classification.type === "invalid" ? classification.reason : "think-only"
              if (yield* autoContinueInvalidOutput({ lastUser, assistant: lastAssistant, reason })) continue
              yield* slog.info("exiting loop", { classification: classification.type })
              break
            }
            if (classification.type === "final" && classification.degraded)
              yield* slog.warn("degraded final on abnormal finish", { finish: lastAssistant.finish })
            if (classification.type !== "continue") {
              if (yield* taskGate(lastUser)) continue
              if (yield* goalGate(lastUser)) continue
              yield* slog.info("exiting loop", { classification: classification.type })
              break
            }
          }

          step++
          if (step === 1)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          if (step === 1 && !session.parentID) {
            const cfg = yield* config.get()
            const dreamTrigger = yield* shouldAutoDream(cfg).pipe(Effect.catch(() => Effect.succeed(false)))
            const distillTrigger = yield* shouldAutoDistill(cfg).pipe(Effect.catch(() => Effect.succeed(false)))
            const mdl = { providerID: lastUser.model.providerID, modelID: lastUser.model.modelID }
            // AppRuntime is imported dynamically (not at module top level) to keep
            // the session layer out of the app-runtime module-init cycle
            // (prompt → app-runtime → AppLayer → SessionPrompt). Only loaded when a
            // trigger actually fires. Detached fire-and-forget on the full runtime.
            if (dreamTrigger || distillTrigger) {
              const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
              if (dreamTrigger) {
                AppRuntime.runPromise(
                  Session.Service.use((svc) =>
                    Effect.gen(function* () {
                      const s = yield* svc.create({ title: AUTO_DREAM_TITLE })
                      const sp = yield* Service
                      yield* sp.prompt({ sessionID: s.id, agent: "dream", model: mdl, parts: [{ type: "text", text: DREAM_TASK }] })
                    }),
                  ),
                ).catch((err) => log.error("auto-dream prompt failed", { error: String(err) }))
              }
              if (distillTrigger) {
                AppRuntime.runPromise(
                  Session.Service.use((svc) =>
                    Effect.gen(function* () {
                      const s = yield* svc.create({ title: AUTO_DISTILL_TITLE })
                      const sp = yield* Service
                      yield* sp.prompt({ sessionID: s.id, agent: "distill", model: mdl, parts: [{ type: "text", text: DISTILL_TASK }] })
                    }),
                  ),
                ).catch((err) => log.error("auto-distill prompt failed", { error: String(err) }))
              }
            }
          }

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          lastModelForPrune = model
          lastFinishedForPrune = lastFinished
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          // Detect compaction boundary: if the last user message has a compaction
          // part, route to compact.process() instead of the normal LLM flow.
          const lastUserMsgForCompaction = msgs.findLast((m) => m.info.role === "user")
          if (lastUserMsgForCompaction?.parts.some((p) => p.type === "compaction")) {
            const compactionPart = lastUserMsgForCompaction.parts.find(
              (p): p is MessageV2.CompactionPart => p.type === "compaction",
            )
            const allMsgs = yield* sessions.messages({ sessionID, agentID: lastUser.agentID ?? "main" })
            const result = yield* compaction.process({
              parentID: lastUser.id,
              messages: allMsgs,
              sessionID,
              auto: compactionPart?.auto ?? false,
              overflow: compactionPart?.overflow,
              agentID: lastUser.agentID,
            })
            if (result === "stop") break
            continue
          }

          // Memory flush nudge at high context pressure
          if (lastFinished && lastFinished.summary !== true && model) {
            const cfg = yield* config.get()
            const pressure = pressureLevel({ cfg, tokens: lastFinished.tokens, model })
            if (pressure >= 2) {
              // Inject nudge as a synthetic text part on the last user message
              const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
              if (
                lastUserMsg &&
                !lastUserMsg.parts.some((p) => p.type === "text" && p.text?.includes("Context is filling up"))
              ) {
                lastUserMsg.parts.push({
                  id: PartID.ascending(),
                  messageID: lastUserMsg.info.id,
                  sessionID,
                  type: "text",
                  synthetic: true,
                  text: [
                    "<system-reminder>",
                    `Context is filling up (${pressure >= 3 ? ">85%" : ">70%"}).`,
                    "If you have important learnings or decisions from this session,",
                    "consider writing them to memory now before context may be reset.",
                    "</system-reminder>",
                  ].join("\n"),
                })
              }
            }
          }

          // Repeated-step nudge: if the last REPEATED_STEP_THRESHOLD finished
          // assistant steps made an identical tool call, the model is likely
          // stuck looping. Inject a reminder on the last user message asking it
          // to change approach. Mirrors the memory-flush nudge above (synthetic
          // text part, deduped per build).
          if (lastFinished) {
            const recentSignatures: string[] = []
            for (let i = msgs.length - 1; i >= 0 && recentSignatures.length < REPEATED_STEP_THRESHOLD; i--) {
              const m = msgs[i]
              if (m.info.role !== "assistant" || !m.info.finish) continue
              const sig = stepSignature(m.parts)
              if (sig === undefined) break
              recentSignatures.push(sig)
            }
            const repeating =
              recentSignatures.length === REPEATED_STEP_THRESHOLD &&
              recentSignatures.every((sig) => sig === recentSignatures[0])
            if (repeating) {
              const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
              if (
                lastUserMsg &&
                !lastUserMsg.parts.some(
                  (p) => p.type === "text" && p.text?.includes("repeating the same action"),
                )
              ) {
                lastUserMsg.parts.push({
                  id: PartID.ascending(),
                  messageID: lastUserMsg.info.id,
                  sessionID,
                  type: "text",
                  synthetic: true,
                  text: [
                    "<system-reminder>",
                    `Your last ${REPEATED_STEP_THRESHOLD} steps have been identical — you appear to be`,
                    "repeating the same action without making progress. Stop and reconsider:",
                    "the current approach is not working. Try a different strategy, use a",
                    "different tool, or if you are blocked, explain the blocker to the user",
                    "instead of repeating the same step again.",
                    "</system-reminder>",
                  ].join("\n"),
                })
              }
            }
          }

          // Resolve the agent for this iteration once. Both the management
          // hooks below (fireCheckpoints, overflow handler) and the existing
          // agent-not-found check later in the iteration reuse this binding.
          // Bounded computation agents (native + hidden — currently title,
          // summary, checkpoint-writer) are exempt from context management;
          // see docs/superpowers/specs/2026-04-28-bounded-computation-agents-design.md
          const agent = yield* agents.get(lastUser.agent)
          const isBoundedComputation =
            agent?.native === true && agent?.hidden === true

          // Fire background checkpoint writers for any newly-crossed thresholds
          // based on the latest completed assistant message's tokens. Must run
          // BEFORE the overflow/maxThreshold check below so maxCrossed flag is
          // set in time to trigger rebuild on this same iteration.
          if (!skipOverflowCheck && !isBoundedComputation && lastFinished && lastFinished.tokens) {
            const fireOps = yield* ops()
            yield* prune
              .fireCheckpoints({
                sessionID,
                model,
                tokens: lastFinished.tokens,
                promptOps: fireOps,
                agentID: lastUser.agentID,
              })
              .pipe(Effect.ignore)
          }

          if (
            !skipOverflowCheck &&
            !isBoundedComputation &&
            lastFinished &&
            lastFinished.summary !== true &&
            (overflowCheck({ cfg: yield* config.get(), tokens: lastFinished.tokens, model }) ||
              (yield* prune.maxThresholdCrossed(sessionID)))
          ) {
            // Subagent overflow → per-actor compaction (lossy LLM summarization
            // scoped to the actor's (sessionID, agent_id) slice). Subagents
            // don't have checkpoints, so checkpoint+discard does not apply.
            // Gate must exclude agentID="main" — F49+F50 made main carry
            // agentID="main", so a bare `if (lastUser.agentID)` would route
            // main to this subagent path and skip the checkpoint rebuild
            // below. See checkpoint.ts:715 for the matching gate.
            if (lastUser.agentID && lastUser.agentID !== "main") {
              yield* compaction
                .create({
                  sessionID,
                  agent: lastUser.agent,
                  model: { providerID: model.providerID, modelID: model.id },
                  auto: true,
                  agentID: lastUser.agentID,
                })
                .pipe(Effect.ignore)
              // After inserting the boundary, the actor's filterCompactedEffect
              // slice begins at the boundary marker — context is freed for the
              // next iteration's stream. Skip the next overflow check so the
              // model can respond on the trimmed context.
              skipOverflowCheck = true
              continue
            }

            // Main-agent overflow: insert a checkpoint boundary marker (never
            // deletes DB messages) so the next iteration rebuilds from the
            // freshest checkpoint. Fall back to compaction only when no boundary
            // can be produced.
            const hasCP = yield* checkpoint.hasCheckpoint(sessionID).pipe(Effect.catch(() => Effect.succeed(false)))
            if (hasCP) {
              // Wait for any running writer so the freshest checkpoint is available
              yield* checkpoint.waitForWriter(sessionID).pipe(Effect.ignore)

              const boundary = yield* checkpoint
                .lastBoundary(sessionID)
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
              const boundaryMsg = boundary ? msgs.find((m) => m.info.id === boundary) : undefined
              const inserted = boundary
                ? yield* checkpoint
                    .insertRebuildBoundary({
                      sessionID,
                      boundary,
                      lastMessageInfo: computeLastMessageInfo(msgs.map((m) => m.info)),
                      agentID: lastUser.agentID,
                      agent: lastUser.agent,
                      model: { providerID: model.providerID, modelID: model.id },
                      boundaryCreatedAt: boundaryMsg?.info.time.created,
                    })
                    .pipe(Effect.catch(() => Effect.succeed(false)))
                : false

              if (inserted) {
                yield* prune.resetThresholds(sessionID)
                skipOverflowCheck = true
                continue
              }
            }

            // F39: no checkpoint — fall back to compaction (LLM-driven lossy summary).
            // Better than mechanical trim: preserves semantic content via summary.
            yield* compaction
              .create({
                sessionID,
                agent: lastUser.agent,
                model: { providerID: model.providerID, modelID: model.id },
                auto: true,
                agentID: lastUser.agentID,
              })
              .pipe(Effect.ignore)
            skipOverflowCheck = true
            continue
          }
          skipOverflowCheck = false

          // `agent` resolved at iteration start; reuse here for the
          // agent-not-found user-visible error.
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const maxSteps = agent.steps ?? Infinity
          const isLastStep = step >= maxSteps
          msgs = yield* insertReminders({ messages: msgs, agent, session })

          const msg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            agentID: lastUser.agentID,
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)
          const handle = yield* processor.create({
            assistantMessage: msg,
            sessionID,
            model,
            agentMetrics,
          })

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

            const tools = yield* resolveTools({
              agent,
              session,
              model,
              tools: lastUser.tools,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
              agentID: lastUser.agentID,
              task_id,
            })

            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            if (step > 1 && lastFinished) {
              for (const m of msgs) {
                if (m.info.role !== "user" || m.info.id <= lastFinished.id) continue
                for (const p of m.parts) {
                  if (p.type !== "text" || p.ignored || p.synthetic) continue
                  if (!p.text.trim()) continue
                  p.text = [
                    "<system-reminder>",
                    "The user sent the following message:",
                    p.text,
                    "",
                    "Please address this message and continue with your tasks.",
                    "</system-reminder>",
                  ].join("\n")
                }
              }
            }

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            const format = lastUser.format ?? { type: "text" as const }

            // Determine if this iteration is for a fork agent (contextMode === "full").
            // Fork agents use the frozen ForkContext snapshot captured at spawn time
            // (system + inheritedMessages) rather than recomputing from their own
            // agent identity — which would diverge from the parent and break the
            // prefix cache.
            const actorRecord = lastUser.agentID
              ? yield* actorRegistry.get(sessionID, lastUser.agentID).pipe(
                  Effect.orElseSucceed(() => undefined),
                )
              : undefined
            // v9 registers main as `mode: "main"` with `contextMode: "full"`.
            // Only spawned actors (subagent/peer) carry a frozen ForkContext;
            // main is the captor, never the captured.
            const isForkAgent =
              actorRecord?.contextMode === "full" &&
              (actorRecord.mode === "subagent" || actorRecord.mode === "peer")

            // Fork path: read frozen ForkContext from Actor service (late-bound via
            // spawnRef to break the Actor → SessionPrompt → Actor layer cycle).
            // If forkCtx is missing (race / cleanup bug / spawn skipped), fail the
            // actor so the next prune turn can spawn a fresh fork.
            if (isForkAgent) {
              const forkCtxEffect = spawnRef.current?.getForkContext(lastUser.agentID!)
              const forkCtx = forkCtxEffect ? yield* forkCtxEffect : undefined
              if (!forkCtx) {
                yield* slog.warn("fork agent runLoop: missing forkContext, failing actor", {
                  sessionID,
                  agentID: lastUser.agentID,
                })
                yield* actorRegistry
                  .updateStatus(sessionID, lastUser.agentID!, { status: "idle", lastOutcome: "failure", lastError: "missing fork context" })
                  .pipe(Effect.ignore)
                return "break" as const
              }
              const ownNew = msgs.filter(
                (m) => m.info.id > forkCtx.watermarkMsgID && m.info.agentID === lastUser.agentID,
              )
              const ownNewModelMsgs = yield* MessageV2.toModelMessagesEffect(ownNew, model)
              const prebuiltSystem = forkCtx.system
              const modelMsgs: ModelMessage[] = [...forkCtx.inheritedMessages, ...ownNewModelMsgs]
              // additions is empty for fork agents: system is taken verbatim from
              // forkCtx.system. Passed as `system` to handle.process for logging/replay.
              const additions: string[] = []
              // Note: fork uses `tools` from resolveTools (not `forkCtx.tools`) — runtime
              // tool dispatch needs execute closures, which `forkCtx.tools` does not carry.
              // Schema parity with parent is currently a consequence of checkpoint-writer
              // having no toolAllowlist (Task 2.6 + agent.test.ts guard). See ForkContext.tools
              // JSDoc in packages/opencode/src/actor/spawn.ts for the full contract.
              const queryParts =
                msgs.findLast((m) => m.info.role === "user" && m.info.id === lastUser.id)?.parts ?? []
              const query = userQueryText(queryParts)
              const preQuery = {
                cancel: undefined as boolean | undefined,
                cancelReason: undefined as string | undefined,
              }
              yield* plugin.trigger(
                "session.userQuery.pre",
                { sessionID, agentID: resolvedAgentID, step, messageID: lastUser.id, query },
                preQuery,
              )
              if (preQuery.cancel) {
                cancelled = true
                cancelReason = preQuery.cancelReason
                handle.message.error = new MessageV2.AbortedError({
                  message: preQuery.cancelReason ?? "Step cancelled by plugin",
                }).toObject()
                handle.message.finish = "cancelled"
                yield* sessions.updateMessage(handle.message)
                yield* plugin.trigger(
                  "session.userQuery.post",
                  {
                    sessionID,
                    agentID: resolvedAgentID,
                    step,
                    messageID: lastUser.id,
                    query,
                    assistantMessageID: handle.message.id,
                    finish: handle.message.finish,
                    error: preQuery.cancelReason,
                    trajectory: trajectoryForStep(msgs, handle.message),
                  },
                  {},
                )
                return "break" as const
              }
              const result = yield* handle
                .process({
                  user: lastUser,
                  agent,
                  // Fork inherits the parent agent's permission (captured at spawn into
                  // ForkContext). This drives llm.ts resolveTools/disabled() to the SAME
                  // visible tool set as the parent → prompt-cache parity on the inherited
                  // prefix. Scope: this affects tool VISIBILITY only; the per-call ask
                  // ruleset (built separately in resolveTools' ask closure) is unchanged.
                  // Parity is exact modulo non-default `session.permission`: the parent's
                  // visibility ruleset is merge(parent.permission, session.permission)
                  // while the fork's is merge(writer.permission, parentPermission) — so a
                  // session-level rule pins the parent but not the fork. Still a strict
                  // improvement over the old bespoke "*":"deny" block (which always
                  // diverged). The `?? session.permission` is defense-in-depth only:
                  // parentPermission is a required field (empty `[]` on a missed capture,
                  // which `??` does NOT override), so the fallback fires solely if a future
                  // refactor makes the field optional.
                  permission: forkCtx.parentPermission ?? session.permission,
                  sessionID,
                  parentSessionID: session.parentID,
                  system: additions,
                  prebuiltSystem,
                  messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
                  tools,
                  model,
                  toolChoice: format.type === "json_schema" ? "required" : undefined,
                  agentID: lastUser.agentID,
                })
                .pipe(
                  Effect.onExit((exit) =>
                    plugin
                      .trigger(
                        "session.userQuery.post",
                        {
                          sessionID,
                          agentID: resolvedAgentID,
                          step,
                          messageID: lastUser.id,
                          query,
                          assistantMessageID: handle.message.id,
                          finish: handle.message.finish,
                          error: Exit.isFailure(exit)
                            ? Cause.pretty(exit.cause)
                            : sessionErrorText(handle.message.error),
                          finalText: assistantFinalText(handle.message, MessageV2.parts(handle.message.id)),
                          trajectory: trajectoryForStep(msgs, handle.message),
                        },
                        {},
                      )
                      .pipe(Effect.ignore),
                  ),
                )

              if (
                result === "continue" &&
                (yield* autoContinueOutputLength({ lastUser, assistant: handle.message }))
              ) {
                return "continue" as const
              }

              if (result === "text-repeat") {
                if (yield* handleTextRepeat({ lastUser })) return "continue" as const
                return "break" as const
              }

              if (structured !== undefined) {
                handle.message.structured = structured
                handle.message.finish = handle.message.finish ?? "stop"
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }

              const forkClassification = classifyAssistantStep({
                phase: "after-process",
                lastUser,
                assistant: handle.message,
                parts: MessageV2.parts(handle.message.id),
                processResult: result,
              })
              if (forkClassification.type === "filtered") {
                yield* writeContentFilterError({ assistant: handle.message })
                return "break" as const
              }
              if (forkClassification.type === "failed") {
                yield* writeModelError({ assistant: handle.message, reason: forkClassification.reason })
                return "break" as const
              }
              if (forkClassification.type !== "continue" && !handle.message.error && format.type === "json_schema") {
                if (yield* autoRetryStructuredOutput({ lastUser, assistant: handle.message }))
                  return "continue" as const
                return "break" as const
              }

              if (
                (forkClassification.type === "think-only" || forkClassification.type === "invalid") &&
                format.type !== "json_schema"
              ) {
                const reason =
                  forkClassification.type === "invalid" ? forkClassification.reason : "think-only"
                if (yield* autoContinueInvalidOutput({ lastUser, assistant: handle.message, reason }))
                  return "continue" as const
                return "break" as const
              }

              if (forkClassification.type === "final" && forkClassification.degraded)
                yield* slog.warn("degraded final on abnormal finish", { finish: handle.message.finish })
              if (result === "stop") return "break" as const
              // Fork agents are always subagents (lastUser.agentID is set); use
              // per-actor compaction on overflow (same as non-fork subagent path).
              if (!isBoundedComputation && result === "overflow") {
                yield* compaction
                  .create({
                    sessionID,
                    agent: lastUser.agent,
                    model: { providerID: model.providerID, modelID: model.id },
                    auto: true,
                    overflow: true,
                    agentID: lastUser.agentID,
                  })
                  .pipe(Effect.ignore)
              }
              return "continue" as const
            }

            const [skills, env, instructions] = yield* Effect.all([
              sys.skills(agent),
              Effect.sync(() => sys.environment(model, session.time.created)),
              instruction.system().pipe(Effect.orDie),
            ])
            // Surface which instruction files (CLAUDE.md, AGENTS.md, ...) were loaded.
            // Only for primary sessions (subagents would be noisy) and once per session.
            if (!session.parentID && !instructionsNotified.has(sessionID)) {
              instructionsNotified.add(sessionID)
              const worktree = (yield* InstanceState.context).worktree
              const files = Array.from(instructions.paths, (p) => Instruction.display(p, worktree))
              if (files.length > 0) {
                yield* bus.publish(TuiEvent.InstructionsLoaded, { files }).pipe(Effect.ignore)
              }
            }
            const additions = [
              ...env,
              ...(skills ? [skills] : []),
              ...instructions.content,
              ...(format.type === "json_schema" ? [STRUCTURED_OUTPUT_SYSTEM_PROMPT] : []),
            ]
            // Note: `buildLLMRequestPrefix` also returns a `tools` field, but we
            // intentionally don't use it here — the `tools` variable from `resolveTools`
            // (set earlier via `handle.process({tools: ...})`) carries `execute` closures
            // the AI SDK needs for runtime tool dispatch, while `buildLLMRequestPrefix`
            // produces schema-only tools. Schema bytes match between both paths (both call
            // registry.tools with identical args), so prefix cache parity holds.
            // Main runLoop: no watermark — LLM must see the full msgs list,
            // including this turn's intermediate assistant turns (tool reads,
            // task creates, etc.) so each step doesn't replay from the bare
            // user prompt. The watermark is for fork capture only (frozen
            // snapshot of parent-view at spawn time).
            const { system: prebuiltSystem, inheritedMessages: modelMsgs } =
              yield* buildLLMRequestPrefix({
                sessionID,
                agent,
                model,
                msgs,
                additions,
              }).pipe(
                Effect.provideService(LLM.Service, llm),
                Effect.provideService(ToolRegistry.Service, registry),
              )
            const maxModeCfg = (yield* config.get()).experimental?.maxMode
            const useMaxMode =
              agent.name === MaxMode.MAX_MODE_AGENT && maxModeCfg !== undefined && format.type !== "json_schema"

            const processArgs = {
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              // system: additions is preserved for non-LLM consumers of StreamInput (e.g.,
              // MessageV2.User.system for logging/replay); llm.stream itself uses prebuiltSystem.
              system: additions,
              prebuiltSystem,
              messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
              tools,
              model,
              toolChoice: format.type === "json_schema" ? ("required" as const) : undefined,
              agentID: lastUser.agentID,
            }

            const queryParts =
              msgs.findLast((m) => m.info.role === "user" && m.info.id === lastUser.id)?.parts ?? []
            const query = userQueryText(queryParts)
            const preQuery = {
              cancel: undefined as boolean | undefined,
              cancelReason: undefined as string | undefined,
            }
            yield* plugin.trigger(
              "session.userQuery.pre",
              { sessionID, agentID: resolvedAgentID, step, messageID: lastUser.id, query },
              preQuery,
            )
            if (preQuery.cancel) {
              cancelled = true
              cancelReason = preQuery.cancelReason
              handle.message.error = new MessageV2.AbortedError({
                message: preQuery.cancelReason ?? "Step cancelled by plugin",
              }).toObject()
              handle.message.finish = "cancelled"
              yield* sessions.updateMessage(handle.message)
              yield* plugin.trigger(
                "session.userQuery.post",
                {
                  sessionID,
                  agentID: resolvedAgentID,
                  step,
                  messageID: lastUser.id,
                  query,
                  assistantMessageID: handle.message.id,
                  finish: handle.message.finish,
                  error: preQuery.cancelReason,
                  trajectory: trajectoryForStep(msgs, handle.message),
                },
                {},
              )
              return "break" as const
            }

            const stepEffect = useMaxMode
              ? MaxMode.runMaxStep({
                  // runMaxStep reuses the identical per-step args as handle.process,
                  // plus the orchestration handles it needs.
                  ...processArgs,
                  handle,
                  llm,
                  candidates: maxModeCfg?.candidates,
                  setStatus: (message) =>
                    status.set(sessionID, message ? { type: "busy", message } : { type: "busy" }),
                })
              : handle.process(processArgs)

            const result = yield* stepEffect.pipe(
              Effect.onExit((exit) =>
                plugin
                  .trigger(
                    "session.userQuery.post",
                    {
                      sessionID,
                      agentID: resolvedAgentID,
                      step,
                      messageID: lastUser.id,
                      query,
                      assistantMessageID: handle.message.id,
                      finish: handle.message.finish,
                      error: Exit.isFailure(exit)
                        ? Cause.pretty(exit.cause)
                        : sessionErrorText(handle.message.error),
                      finalText: assistantFinalText(handle.message, MessageV2.parts(handle.message.id)),
                      trajectory: trajectoryForStep(msgs, handle.message),
                    },
                    {},
                  )
                  .pipe(Effect.ignore),
              ),
            )

            if (
              result === "continue" &&
              (yield* autoContinueOutputLength({ lastUser, assistant: handle.message }))
            ) {
              return "continue" as const
            }

            if (result === "text-repeat") {
              if (yield* handleTextRepeat({ lastUser })) return "continue" as const
              return "break" as const
            }

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const classification = classifyAssistantStep({
              phase: "after-process",
              lastUser,
              assistant: handle.message,
              parts: MessageV2.parts(handle.message.id),
              processResult: result,
            })
            if (classification.type === "filtered") {
              yield* writeContentFilterError({ assistant: handle.message })
              return "break" as const
            }
            if (classification.type === "failed") {
              yield* writeModelError({ assistant: handle.message, reason: classification.reason })
              return "break" as const
            }
            if (classification.type !== "continue" && !handle.message.error && format.type === "json_schema") {
              if (yield* autoRetryStructuredOutput({ lastUser, assistant: handle.message })) return "continue" as const
              return "break" as const
            }

            if (
              (classification.type === "think-only" || classification.type === "invalid") &&
              format.type !== "json_schema"
            ) {
              const reason = classification.type === "invalid" ? classification.reason : "think-only"
              if (yield* autoContinueInvalidOutput({ lastUser, assistant: handle.message, reason }))
                return "continue" as const
              return "break" as const
            }

            if (classification.type === "final" && classification.degraded)
              yield* slog.warn("degraded final on abnormal finish", { finish: handle.message.finish })
            if (result === "stop") return "break" as const
            if (!isBoundedComputation && result === "overflow") {
              // Subagent overflow → per-actor compaction. Insert a boundary
              // tagged with the subagent's agent_id; the next runLoop iteration
              // will see a trimmed context (filterCompactedEffect stops at
              // the boundary).
              // Gate must exclude "main" — see comment at the matching gate
              // earlier in this file (~line 1716) and at checkpoint.ts:715.
              if (lastUser.agentID && lastUser.agentID !== "main") {
                yield* compaction
                  .create({
                    sessionID,
                    agent: lastUser.agent,
                    model: { providerID: model.providerID, modelID: model.id },
                    auto: true,
                    overflow: true,
                    agentID: lastUser.agentID,
                  })
                  .pipe(Effect.ignore)
                return "continue" as const
              }

              // Main-agent provider-signalled overflow: insert a checkpoint
              // boundary marker (never deletes). Prefer rebuild over compaction:
              // if a writer is running or finished, wait (bounded) and rebuild
              // from it. Fall back to compaction only when no boundary exists.
              const writerRunning = yield* checkpoint.isWriterRunning(sessionID)
                .pipe(Effect.catch(() => Effect.succeed(false)))
              const hasCP = yield* checkpoint.hasCheckpoint(sessionID)
                .pipe(Effect.catch(() => Effect.succeed(false)))

              if (writerRunning || hasCP) {
                yield* checkpoint.waitForWriter(sessionID).pipe(Effect.ignore)
                const boundary2 = yield* checkpoint.lastBoundary(sessionID)
                  .pipe(Effect.catch(() => Effect.succeed(undefined)))
                const boundary2Msg = boundary2 ? msgs.find((m) => m.info.id === boundary2) : undefined
                const inserted2 = boundary2
                  ? yield* checkpoint
                      .insertRebuildBoundary({
                        sessionID,
                        boundary: boundary2,
                        lastMessageInfo: computeLastMessageInfo(msgs.map((m) => m.info)),
                        agentID: lastUser.agentID,
                        agent: lastUser.agent,
                        model: { providerID: model.providerID, modelID: model.id },
                        boundaryCreatedAt: boundary2Msg?.info.time.created,
                      })
                      .pipe(Effect.catch(() => Effect.succeed(false)))
                  : false

                if (inserted2) {
                  yield* prune.resetThresholds(sessionID)
                  return "continue" as const
                }
              }

              // F39: no checkpoint — fall back to compaction (LLM-driven lossy summary).
              yield* compaction
                .create({
                  sessionID,
                  agent: lastUser.agent,
                  model: { providerID: model.providerID, modelID: model.id },
                  auto: true,
                  overflow: true,
                  agentID: lastUser.agentID,
                })
                .pipe(Effect.ignore)
            }
            return "continue" as const
          }).pipe(Effect.ensuring(instruction.clear(handle.message.id)))

          // --- Text Loop Detection (cross-step) ---
          const completedParts = MessageV2.parts(handle.message.id)
          const stepText = completedParts
            .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic)
            .map((p) => p.text)
            .join(" ")
          if (stepText.trim()) {
            // Include tool call signatures in the key so same text + different tools ≠ loop
            const toolSig = completedParts
              .filter((p): p is MessageV2.ToolPart => p.type === "tool")
              .map((p) => `${p.tool}:${JSON.stringify(p.state && "input" in p.state ? p.state.input : "")}`)
              .join("|")
            const normalized = normalizeForLoopDetection(stepText) + (toolSig ? `\0${toolSig}` : "")
            textLoopBuffer.push(normalized)
            if (textLoopBuffer.length > TEXT_LOOP_BUFFER_SIZE) textLoopBuffer.shift()

            if (textLoopBuffer.length >= TEXT_LOOP_TRIGGER_COUNT) {
              const isTextLoop = detectTextLoop(textLoopBuffer, TEXT_LOOP_TRIGGER_COUNT)

              if (isTextLoop) {
                if (textLoopRecoveryAttempts >= TEXT_LOOP_MAX_RECOVERY) {
                  yield* slog.info("text loop: max recovery exceeded, terminating")
                  yield* bus.publish(Session.Event.Error, {
                    sessionID,
                    error: new NamedError.Unknown({
                      message: `Text loop detected: model repeated the same output ${TEXT_LOOP_TRIGGER_COUNT} times after ${TEXT_LOOP_MAX_RECOVERY} recovery attempts. Session terminated.`,
                    }).toObject(),
                  })
                  break
                }
                const recoveryText =
                  textLoopRecoveryAttempts === 0 ? RECOVERY_PROMPT_MILD : RECOVERY_PROMPT_STRONG
                // Create a NEW user message at the end of conversation (not append to original)
                const reentry = yield* sessions.updateMessage({
                  id: MessageID.ascending(),
                  role: "user" as const,
                  sessionID,
                  agentID: lastUser.agentID,
                  agent: lastUser.agent,
                  model: lastUser.model,
                  tools: lastUser.tools,
                  format: lastUser.format,
                  time: { created: Date.now() },
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: reentry.id,
                  sessionID,
                  type: "text",
                  synthetic: true,
                  text: recoveryText,
                } satisfies MessageV2.TextPart)
                textLoopRecoveryAttempts++
                textLoopBuffer.length = 0
                yield* slog.info("text loop: recovery injected", { attempt: textLoopRecoveryAttempts })
                continue
              }
            }
          }

          if (outcome === "break") {
            if (yield* taskGate(lastUser)) continue
            if (yield* goalGate(lastUser)) continue
            break
          }
          continue
        }

        const promptOps = yield* ops()
        if (lastModelForPrune && lastFinishedForPrune) {
          yield* prune
            .prune({
              sessionID,
              model: lastModelForPrune,
              tokens: lastFinishedForPrune.tokens,
              lastAssistantTime: lastFinishedForPrune.time.completed,
              promptOps,
            })
            .pipe(Effect.ignore, Effect.forkIn(scope))
        }
        const final = yield* lastAssistant(sessionID, agentID)
        const finalIsError = final.info.role === "assistant" && !!final.info.error
        const lastUserForMetrics = yield* sessions.findMessage(
          sessionID,
          (m) => m.info.role === "user",
          { agentID: "*" },
        )
        yield* publishAgentRequest(
          finalIsError ? "error" : "completed",
          Option.isSome(lastUserForMetrics) ? lastUserForMetrics.value.info.agent : final.info.agent,
        )
        return final
        }).pipe(Effect.onExit(firePostSession), Effect.orDie)
      },
    )

    const loop: (input: z.infer<typeof LoopInput>) => Effect.Effect<MessageV2.WithParts> = Effect.fn(
      "SessionPrompt.loop",
    )(function* (input: z.infer<typeof LoopInput>) {
      const agentID = input.agentID ?? "main"
      return yield* state.ensureRunning(
        input.sessionID,
        agentID,
        lastAssistant(input.sessionID, agentID),
        runLoop(input.sessionID, agentID, input.task_id),
      )
    })

    const shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.shell")(
      function* (input: ShellInput) {
        return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input))
      },
    )

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* elog.info("command", { sessionID: input.sessionID, command: input.command, agent: input.agent })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent ?? (yield* agents.defaultAgent())

      // /goal — set or clear a session-level stop-condition goal. The condition
      // text itself becomes the prompt for this turn (the working agent starts
      // pursuing it immediately); the main runLoop then refuses to stop until
      // the judge says it's satisfied. See session/goal.ts.
      if (input.command === Command.Default.GOAL) {
        const condition = input.arguments.trim()
        if (condition === "" || condition === "clear" || condition === "reset") {
          yield* goal.clear(input.sessionID)
          return yield* prompt({
            sessionID: input.sessionID,
            messageID: input.messageID,
            agent: agentName,
            parts: [{ type: "text", text: "Goal cleared.", synthetic: true }],
            noReply: true,
          })
        }
        yield* goal.set(input.sessionID, condition)
      }

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      let template: string
      if (cmd.source === "skill") {
        template = input.arguments
      } else {
        const placeholders = templateCommand.match(placeholderRegex) ?? []
        let last = 0
        for (const item of placeholders) {
          const value = Number(item.slice(1))
          if (value > last) last = value
        }

        const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
          const position = Number(index)
          const argIndex = position - 1
          if (argIndex >= args.length) return ""
          if (position === last) return args.slice(argIndex).join(" ")
          return args[argIndex]
        })
        const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
        template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

        if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
          template = template + "\n\n" + input.arguments
        }
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const sh = Shell.preferred()
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* lastModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = yield* agents.get(agentName)
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true

      let parts: PromptInput["parts"]
      if (isSubtask) {
        const promptText = cmd.source === "skill"
          ? templateCommand + (input.arguments.trim() ? "\n\n" + input.arguments : "")
          : (templateParts.find((y): y is typeof y & { type: "text"; text: string } => y.type === "text"))?.text ?? ""
        parts = [
          {
            type: "subtask" as const,
            agent: agent.name,
            description: cmd.description ?? "",
            command: input.command,
            model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
            prompt: promptText,
          },
        ]
      } else if (cmd.source === "skill") {
        const visibleText = input.arguments.trim()
          ? `/${input.command} ${input.arguments}`
          : `/${input.command}`
        const skillPart = {
          type: "text" as const,
          text: `<skill_content name="${input.command}">\n${templateCommand}\n</skill_content>`,
          synthetic: true,
        }
        const attachments = templateParts.filter((p): p is Exclude<typeof p, { type: "text" }> => p.type !== "text")
        parts = [{ type: "text" as const, text: visibleText }, skillPart, ...attachments, ...(input.parts ?? [])]
      } else {
        parts = [...templateParts, ...(input.parts ?? [])]
      }

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultAgent())) : agentName
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* lastModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* bus.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    const impl = Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
      sweepOrphanAssistants,
      predict,
    })
    sessionPromptRef.current = { loop: impl.loop }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (sessionPromptRef.current?.loop === impl.loop) sessionPromptRef.current = undefined
      }),
    )
    return impl
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionPrune.defaultLayer),
    Layer.provide(SessionCheckpoint.defaultLayer),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(ToolRegistry.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        Config.defaultLayer,
        SessionSummary.defaultLayer,
        Team.defaultLayer,
        ActorRegistry.defaultLayer,
        Agent.defaultLayer,
        SystemPrompt.defaultLayer,
        LLM.defaultLayer,
        Bus.layer,
        CrossSpawnSpawner.defaultLayer,
        Inbox.defaultLayer,
        Goal.defaultLayer,
        TaskGateState.defaultLayer,
        TaskRegistry.defaultLayer,
      ),
    ),
  ),
)
export const PromptInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  modelRef: z
    .string()
    .optional()
    .describe(
      "Model group/tier name (e.g. ultra/standard/lite) or a literal provider/model. Resolved provider-aware. Takes precedence over `model` when both are set.",
    ),
  agent: z.string().optional(),
  agentID: z.string().optional(),
  task_id: z.string().optional()
    .describe("If the spawning caller bound this prompt to a specific user-task (T4 etc), pass its TID. Propagates to Tool.Context.taskId so memory-path-guard allows writes to tasks/<task_id>/*.md."),
  source: z.enum(["user", "spawn", "hook"]).optional(),
  provenance: MessageV2.Provenance.optional(),
  noReply: z.boolean().optional(),
  tools: z
    .record(z.string(), z.boolean())
    .optional()
    .describe("@deprecated tools and permissions have been merged, you can set permissions on the session itself now"),
  format: MessageV2.Format.optional(),
  system: z.string().optional(),
  variant: z.string().optional(),
  parts: z.array(
    z.discriminatedUnion("type", [
      MessageV2.TextPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "TextPartInput",
        }),
      MessageV2.FilePart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "FilePartInput",
        }),
      MessageV2.AgentPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "AgentPartInput",
        }),
      MessageV2.SubtaskPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "SubtaskPartInput",
        }),
    ]),
  ),
})
export type PromptInput = z.infer<typeof PromptInput>

export const LoopInput = z.object({
  sessionID: SessionID.zod,
  agentID: z.string().optional(),
  task_id: z.string().optional(),
})

export const ShellInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
  agent: z.string(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  modelRef: z
    .string()
    .optional()
    .describe(
      "Model group/tier name (e.g. ultra/standard/lite) or a literal provider/model. Resolved provider-aware. Takes precedence over `model` when both are set.",
    ),
  command: z.string(),
})
export type ShellInput = z.infer<typeof ShellInput>

export const CommandInput = z.object({
  messageID: MessageID.zod.optional(),
  sessionID: SessionID.zod,
  agent: z.string().optional(),
  model: z.string().optional(),
  arguments: z.string(),
  command: z.string(),
  variant: z.string().optional(),
  parts: z
    .array(
      z.discriminatedUnion("type", [
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        }).partial({
          id: true,
        }),
      ]),
    )
    .optional(),
})
export type CommandInput = z.infer<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export * as SessionPrompt from "./prompt"
