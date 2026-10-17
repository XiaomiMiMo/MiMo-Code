import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import z from "zod"

export const ReceiptUpdated = BusEvent.define(
  "session.receipt.updated",
  z.object({
    sessionID: SessionID.zod,
    receiptId: z.string(),
    agentID: z.string(),
    state: z.enum(["accepted", "claimed", "settled", "cancelled", "rejected"]),
    outcome: z.enum(["success", "assistant_error", "interrupted", "never_ran"]).optional(),
    inputMessageID: z.string(),
    deliveryMessageID: z.string().optional(),
    epoch: z.number(),
  }),
)
