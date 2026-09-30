import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import z from "zod"

export const TeamCreated = BusEvent.define(
  "team.created",
  z.object({
    teamID: z.string(),
    creatorSessionID: SessionID.zod,
  }),
)

export const TeamMemberJoined = BusEvent.define(
  "team.member.joined",
  z.object({
    teamID: z.string(),
    sessionID: SessionID.zod,
    agent: z.string(),
    role: z.string(),
  }),
)

