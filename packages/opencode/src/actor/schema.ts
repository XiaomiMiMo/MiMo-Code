import z from "zod"
import { SessionID, MessageID } from "@/session/schema"

export const ActorStatus = z.enum(["pending", "running", "idle"])
export type ActorStatus = z.infer<typeof ActorStatus>

export const ActorOutcome = z.enum(["success", "failure", "cancelled"])
export type ActorOutcome = z.infer<typeof ActorOutcome>

export const Lifecycle = z.enum(["ephemeral", "persistent"])
export type Lifecycle = z.infer<typeof Lifecycle>

export const ContextMode = z.enum(["none", "state", "full"])
export type ContextMode = z.infer<typeof ContextMode>

export const SpawnMode = z.enum(["peer", "subagent", "main"])
export type SpawnMode = z.infer<typeof SpawnMode>

export const ToolWhitelist = z.union([z.array(z.string()).readonly(), z.literal("INHERIT")])
export type ToolWhitelist = z.infer<typeof ToolWhitelist>

export const Actor = z
  .object({
    sessionID: SessionID.zod,
    actorID: z.string(),
    mode: SpawnMode,
    parentActorID: z.string().optional(),
    status: ActorStatus,
    lastOutcome: ActorOutcome.optional(),
    lifecycle: Lifecycle,
    agent: z.string(),
    description: z.string(),
    contextMode: ContextMode,
    contextWatermark: MessageID.zod.optional(),
    background: z.boolean(),
    tools: ToolWhitelist.optional(),
    lastTurnTime: z.number(),
    turnCount: z.number(),
    lastError: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      completed: z.number().optional(),
    }),
  })
  .meta({ ref: "Actor" })
export type Actor = z.infer<typeof Actor>
