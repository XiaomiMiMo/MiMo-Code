// Late-bound reference to SessionPrompt.loop. Mirrors actor/spawn-ref.ts.
//
// Inbox.send needs to "wake" a receiver — i.e. make sure SessionPrompt.loop
// runs once for (receiverSessionID, receiverActorID). Wiring SessionPrompt
// as a normal Layer dependency would form a cycle: SessionPrompt.runLoop
// already calls inbox.drain at the head of every iteration, so Inbox cannot
// also depend on SessionPrompt.
//
// SessionPrompt.layer populates `current` at initialisation; Inbox.send
// reads it at call time. A missing `current` is treated as a runtime guard
// (test fixtures that don't bring up SessionPrompt; renderer-only paths) —
// send still INSERTs the row, but no wake fiber is scheduled.
import type { Effect } from "effect"
import type { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import type { ProviderID, ModelID } from "@/provider/schema"
import type { Interface as InboxInterface } from "./inbox"

export interface SessionPromptLoopRef {
  loop: (input: {
    sessionID: SessionID
    agentID: string
    // The inbox wake path sets this so a persistent background peer that
    // finishes a woken turn notifies its parent (see prompt.ts runLoop terminal).
    notifyParentOnComplete?: boolean
  }) => Effect.Effect<MessageV2.WithParts>
}

export const sessionPromptRef: { current: SessionPromptLoopRef | undefined } = {
  current: undefined,
}

// Late-bound reference to the project default model resolver.
//
// Inbox.drain seeds a synthetic user message that must carry a concrete
// provider/model. It first tries to inherit the model from a prior real
// message (cross-slice), which needs no extra dependency. Only when the
// session/slice has NO model-bearing message yet (a genuine turnCount-0 /
// empty-slice standing peer) does it fall back to the project default —
// resolving that requires Provider, which Inbox.layer intentionally does not
// depend on (keeping the drain hot path and its tests dependency-light). This
// ref reads an ALREADY-WIRED resolver at call time instead of pulling Provider
// into the layer. Mirrors sessionPromptRef: populated by SessionPrompt.layer
// (which already has Provider), undefined in minimal fixtures — a missing
// `current` just means the default-model fallback is unavailable and drain
// leaves the rows durable (option 3).
export interface DefaultModelRef {
  defaultModel: () => Effect.Effect<{ providerID: ProviderID; modelID: ModelID }>
}

export const defaultModelRef: { current: DefaultModelRef | undefined } = {
  current: undefined,
}

// Late-bound reference to Inbox.Service.
//
// tool/actor.ts needs to call inbox.send for the "send" action, but wiring
// Inbox.Service as a normal Layer dependency would require all callers of
// ActorTool to also provide Inbox.Service (including test fixtures that
// don't use the send action). Using this ref keeps the dependency optional:
// send fails gracefully if the inbox service is not available.
//
// Inbox.layer populates `current` at initialisation. A missing `current`
// means the inbox service hasn't been wired (e.g. minimal test fixtures).
export const inboxServiceRef: { current: InboxInterface | undefined } = {
  current: undefined,
}
