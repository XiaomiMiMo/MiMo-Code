import { z } from "zod"

const snapshot = z.object({
  sessionID: z.string(),
  title: z.string(),
  titleSource: z.enum(["fallback", "generated", "user"]),
  titleRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
export type TitleSnapshot = z.infer<typeof snapshot>

export function unchangedTitle(draft: string, original: string) {
  return draft.trim() === original.trim()
}

export function titleConflict(error: unknown, sessionID: string) {
  const result = z.object({ name: z.literal("TitleConflictError"), data: z.object({ current: snapshot }) }).safeParse(error)
  if (!result.success || result.data.data.current.sessionID !== sessionID) return
  return result.data.data.current
}
