import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { ActorStatus, ActorOutcome, SpawnMode } from "./schema"
import z from "zod"

export const ActorRegistered = BusEvent.define(
  "actor.registered",
  z.object({
    sessionID: SessionID.zod,
    actorID: z.string(),
    mode: SpawnMode,
    parentActorID: z.string().optional(),
    description: z.string(),
    agent: z.string(),
    background: z.boolean(),
  }),
)

export const ActorStatusChanged = BusEvent.define(
  "actor.status",
  z.object({
    sessionID: SessionID.zod,
    actorID: z.string(),
    status: ActorStatus,
    lastOutcome: ActorOutcome.optional(),
    turnCount: z.number(),
    lastTurnTime: z.number(),
    error: z.string().optional(),
  }),
)

export const ActorStuck = BusEvent.define(
  "actor.stuck",
  z.object({
    sessionID: SessionID.zod,
    actorID: z.string(),
    description: z.string(),
    lastTurnTime: z.number(),
    stuckDuration: z.number(),
  }),
)

export const WriterCachePerf = BusEvent.define(
  "writer.cache_perf",
  z.object({
    sessionID: SessionID.zod,
    writerActorID: z.string(),
    status: z.enum(["completed", "failed"]),
    total_input_tokens: z.number(),
    cache_read_tokens: z.number(),
    cache_write_tokens: z.number(),
    cache_hit_rate: z.number(),
    num_llm_calls: z.number(),
  }),
)

export const InboxArrived = BusEvent.define(
  "inbox.arrived",
  z.object({
    receiverSessionID: SessionID.zod,
    receiverActorID: z.string(),
    senderSessionID: SessionID.zod.optional(),
    senderActorID: z.string().optional(),
    inboxID: z.string(),
    type: z.string(),
  }),
)
