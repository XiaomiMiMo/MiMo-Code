export function isActorToolRunning(input: {
  partStatus: string
  action?: string
  actorStatus?: string
}) {
  if (input.partStatus === "running") return true
  if (input.partStatus !== "completed") return false
  if (input.action !== "spawn") return false
  return input.actorStatus === "running" || input.actorStatus === "pending"
}
