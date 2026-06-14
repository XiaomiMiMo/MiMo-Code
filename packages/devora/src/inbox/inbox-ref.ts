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
import type { Interface as InboxInterface } from "./inbox"

export interface SessionPromptLoopRef {
  loop: (input: { sessionID: SessionID; agentID: string }) => Effect.Effect<MessageV2.WithParts>
}

export const sessionPromptRef: { current: SessionPromptLoopRef | undefined } = {
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
