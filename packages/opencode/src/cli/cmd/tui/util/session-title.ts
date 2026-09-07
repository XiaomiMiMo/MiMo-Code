import type { Session } from "@mimo-ai/sdk/v2"

export function unchangedTitle(draft: string, original: string | undefined, conflicted: boolean) {
  return !conflicted && original !== undefined && draft.trim() === original.trim()
}

export function titleReadback(
  baseRevision: number | undefined,
  submitted: string,
  current: Session,
  rejectedConflict: boolean,
) {
  if (!rejectedConflict && current.titleSource === "user" && current.title === submitted) return "saved"
  if (rejectedConflict || (current.titleSource === "user" && current.titleRevision !== baseRevision)) return "conflict"
  return "unconfirmed"
}

export function mergeSessionTitle(known: Session | undefined, incoming: Session, conflict?: () => void): Session {
  if (!known) return incoming
  const complete =
    typeof incoming.title === "string" &&
    ["fallback", "generated", "user"].includes(incoming.titleSource) &&
    Number.isSafeInteger(incoming.titleRevision) &&
    incoming.titleRevision >= 0
  if (complete && incoming.titleRevision > known.titleRevision) return incoming
  if (
    complete &&
    incoming.titleRevision === known.titleRevision &&
    (incoming.title !== known.title || incoming.titleSource !== known.titleSource)
  )
    conflict?.()
  return { ...incoming, title: known.title, titleSource: known.titleSource, titleRevision: known.titleRevision }
}
