import z from "zod"
import type { MessageID, SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"

export type Lane = { sessionID: SessionID; agentID: string }

export type ReceiptState = "accepted" | "claimed" | "settled" | "cancelled" | "rejected"
export type ReceiptOutcome = "success" | "assistant_error" | "interrupted" | "never_ran"

export type Receipt = {
  id: string
  lane: Lane
  state: ReceiptState
  type: string
  senderSessionID?: SessionID
  senderActorID?: string
  epoch: number
  runId?: number
  claimFrontier?: MessageID
  consumed: boolean
  outcome?: ReceiptOutcome
  inputMessageID: MessageID
  deliveryMessageID?: MessageID
  error?: string
  idempotencyKey?: string
  time: { created: number; updated: number }
}

export type AcceptInput = {
  lane: Lane
  message: MessageV2.User
  parts: MessageV2.Part[]
  type: string
  senderSessionID?: SessionID
  senderActorID?: string
  idempotencyKey?: string
  legacyInboxID?: string
}

export const ReceiptStateSchema = z.enum(["accepted", "claimed", "settled", "cancelled", "rejected"])
export const ReceiptOutcomeSchema = z.enum(["success", "assistant_error", "interrupted", "never_ran"])

/**
 * Single source for the GET receipt response body and its OpenAPI schema.
 * Internal claim bookkeeping (runId, claimFrontier, idempotencyKey, time) is
 * not part of the external contract.
 */
export const PublicReceipt = z.object({
  id: z.string(),
  lane: z.object({ sessionID: z.string(), agentID: z.string() }),
  state: ReceiptStateSchema,
  type: z.string(),
  senderSessionID: z.string().optional(),
  senderActorID: z.string().optional(),
  epoch: z.number(),
  consumed: z.boolean(),
  outcome: ReceiptOutcomeSchema.optional(),
  inputMessageID: z.string(),
  deliveryMessageID: z.string().optional(),
  error: z.string().optional(),
})
export type PublicReceipt = z.infer<typeof PublicReceipt>

/** Map an internal Receipt onto the external contract (OpenAPI = this shape). */
export function toPublicReceipt(receipt: Receipt): PublicReceipt {
  return {
    id: receipt.id,
    lane: { sessionID: String(receipt.lane.sessionID), agentID: receipt.lane.agentID },
    state: receipt.state,
    type: receipt.type,
    ...(receipt.senderSessionID ? { senderSessionID: String(receipt.senderSessionID) } : {}),
    ...(receipt.senderActorID ? { senderActorID: receipt.senderActorID } : {}),
    epoch: receipt.epoch,
    consumed: receipt.consumed,
    ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
    inputMessageID: String(receipt.inputMessageID),
    ...(receipt.deliveryMessageID ? { deliveryMessageID: String(receipt.deliveryMessageID) } : {}),
    ...(receipt.error ? { error: receipt.error } : {}),
  }
}

export const DEFAULT_AGENT = "main"

/** Single claim batch cap per step boundary. */
export const MAX_CLAIM_PER_STEP = 100
