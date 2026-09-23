import * as Tool from "./tool"
import z from "zod"
import { Effect, Deferred } from "effect"
import { Session } from "@/session"
import { sanitizeGeneratedTitle, truncateTitle } from "@/session/prompt"
import { Provider } from "@/provider"
import { prefixCaptureRef } from "@/session/prefix-capture-ref"
import type { ForkContext, Interface as ActorInterface } from "@/actor/spawn"
import type { SessionID, MessageID } from "../session/schema"
import type { ProviderID, ModelID } from "../provider/schema"

// Wraps the human/agent question in a side-boundary system-reminder:
// one-shot, READ-ONLY, answer-to-caller.
// The hard read-only guarantee comes from the tool whitelist at spawn (only
// read/grep/glob); this prompt reinforces it and forbids continuing the task.
function SIDE_QUESTION_PROMPT(question: string): string {
  return [
    "<system-reminder>",
    "This is a SIDE QUESTION about the session above (a frozen snapshot of its history).",
    "Answer it in a single response from that frozen context.",
    "You MAY use read-only tools (read/grep/glob) to inspect files, but you MUST NOT",
    "modify any file, run any command, or change any state. Do NOT continue, resume, or",
    "execute the session's underlying task — just answer the question, then stop.",
    "</system-reminder>",
    "",
    question,
  ].join("\n")
}

// One-shot, READ-ONLY fork-query: ask a (possibly running) target session a
// side question over a FROZEN snapshot of its history without disturbing its
// turn, and return the answer text. Mechanism mirrors tryStartCheckpointWriter
// (checkpoint.ts): capture the target's prefix at its watermark into a frozen
// ForkContext, spawn an ephemeral subagent over it with read-only tools,
// BLOCK on the outcome, return finalText. Non-interrupting: the fork runs in
// its own child session/actor over a frozen prefix; the target's own messages
// and actor are untouched.
export function forkQuery(deps: {
  sessions: Session.Interface
  provider: Provider.Interface
  actor: ActorInterface
}, targetSessionID: SessionID, question: string, selectedModel?: { providerID: ProviderID; modelID: ModelID }) {
  return Effect.gen(function* () {
    // a. Resolve the target's persisted history and the slice to snapshot.
    // A peer actor runs with actorID === its own sessionID, so SessionPrompt
    // persists its turns under agent_id = <targetSessionID> — NOT "main".
    // Read ALL slices, then pick the slice that actually holds the target's
    // conversation: "main" for a main session, else the peer's own-session slice.
    const all = yield* deps.sessions.messages({ sessionID: targetSessionID, agentID: "*" })
    const sliceOf = (agentID: string) =>
      all.filter((m) => (m.info.agentID ?? "main") === agentID)
    const mainSlice = sliceOf("main")
    // Prefer "main" when it carries real activity; otherwise fall back to the
    // peer child's own-session slice (agent_id === targetSessionID).
    const msgs = mainSlice.some((m) => m.info.role === "user") ? mainSlice : sliceOf(targetSessionID)
    const watermark = msgs.at(-1)?.info.id
    // Graceful: a target whose selected slice has no history (or no user
    // message) can't be snapshotted — buildPrefix needs a user message and
    // there is nothing to ask about. Answer directly instead of spawning.
    const hasUserMessage = msgs.some((m) => m.info.role === "user")
    if (!watermark || msgs.length === 0 || !hasUserMessage)
      return `(session ${targetSessionID} has no activity yet — nothing to ask about.)`

    // b. agentName for the prefix: the target's last assistant agent identity,
    // falling back to "build". Only affects the captured system-prompt baseline;
    // tools are OVERRIDDEN to read-only at spawn regardless.
    const lastAssistant = msgs.findLast((m) => m.info.role === "assistant")
    const agentName = (lastAssistant?.info as { agent?: string } | undefined)?.agent ?? "build"

    // Model for the prefix + the fork's LLM call: the project default. The prefix
    // captor needs a concrete provider/model; the answer quality is the default's.
    const model = selectedModel ?? (yield* deps.provider.defaultModel())
    const providerID = model.providerID as ProviderID
    const modelID = model.modelID as ModelID

    // c. Build the frozen ForkContext via the late-bound prefix captor. If the
    // ref is unset (SessionPrompt.layer not running) we can't snapshot — degrade
    // gracefully rather than spawn a fork that would fail its runLoop.
    const buildPrefix = prefixCaptureRef.current
    if (!buildPrefix) return "(fork-query unavailable: prefix capture not initialized)"
    const prefix = yield* buildPrefix({
      sessionID: targetSessionID,
      agentName,
      providerID,
      modelID,
      msgs,
    })
    const forkCtx = {
      system: prefix.system,
      tools: prefix.tools,
      inheritedMessages: prefix.inheritedMessages,
      parentPermission: prefix.parentPermission,
      watermarkMsgID: watermark as MessageID,
      model: { providerID, modelID },
    } satisfies ForkContext

    // d. Ephemeral child session under the target hosts the query actor (like
    // checkpoint-writer). Parented to the target keeps it discoverable/cleanable.
    const childSession = yield* deps.sessions.create({
      parentID: targetSessionID,
      title: `ask: ${question.slice(0, 40)}`,
    })

    // e. Spawn BLOCKING + READ-ONLY. The tools whitelist (read/grep/glob) is the
    // HARD read-only guarantee: prompt.ts rejects any tool not in this list, so
    // write/edit/bash/patch are unavailable to the fork. background:false so we
    // await the answer; lifecycle:"ephemeral" so the host session is disposable.
    const result = yield* deps.actor.spawn({
      mode: "subagent",
      sessionID: childSession.id,
      parentSessionID: targetSessionID,
      agentType: agentName,
      description: "fork-query",
      task: SIDE_QUESTION_PROMPT(question),
      context: "full",
      tools: ["read", "grep", "glob"],
      model: { providerID, modelID },
      background: false,
      lifecycle: "ephemeral",
      forkContext: forkCtx,
    })
    const outcome = yield* Deferred.await(result.outcome)
    if (outcome.status === "success") return outcome.finalText ?? "(no answer)"
    const reason = outcome.status === "failure" ? outcome.error : outcome.status
    return `(fork-query failed: ${reason})`
  })
}

type Metadata = {
  changed?: boolean
  sessionID?: string
}

const setTitleOperation = z.strictObject({
  action: z.literal("set-title"),
  title: z.string().min(1),
  sessionID: z.string().optional().describe("Omit for the current session; another session cannot be renamed here."),
})
const titleParameters = z.strictObject({ operation: setTitleOperation })
const TITLE_DESCRIPTION = `Set a semantic session title with operation.action=set-title. Omit sessionID for the current session. This is a generated title, never a manual rename: user-protected titles cannot change. Use after understanding an attachment or when the substantive task changes, not for ordinary progress. Never infer a task from a filename alone. Do not retry to force an overwrite.`

function setSessionTitle(sessions: Session.Interface, input: z.infer<typeof setTitleOperation>, ctx: Tool.Context<Metadata>) {
  return Effect.gen(function* () {
    const rejected = { title: "Session title unchanged", output: "Title unchanged: protected, stale, invalid, or ineligible session.", metadata: { changed: false } }
    if (ctx.abort.aborted || (ctx.actorID && ctx.actorID !== "main") || (input.sessionID && input.sessionID !== ctx.sessionID)) return rejected
    const current = yield* sessions.get(ctx.sessionID)
    if (current.parentID || current.titleSource === "user") return rejected
    const title = sanitizeGeneratedTitle(input.title)
    if (!title) return rejected
    const result = yield* sessions.setGeneratedTitle({ sessionID: current.id, title: truncateTitle(title), expectedRevision: current.titleRevision })
    return result ? { title: "Session title updated", output: JSON.stringify(result), metadata: { changed: true } } : rejected
  })
}

export const SessionTitleTool = Tool.define<typeof titleParameters, Metadata, Session.Service>("session", Effect.gen(function* () {
  const sessions = yield* Session.Service
  return { description: TITLE_DESCRIPTION, parameters: titleParameters, execute: (input, ctx) => setSessionTitle(sessions, input.operation, ctx) }
}))
