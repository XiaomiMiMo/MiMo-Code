export function shouldHideTool(input: {
  showDetails: boolean
  tool: string
  status: string
  toolCalls?: number
  execStatus?: string
}) {
  if (
    input.tool === "exec" &&
    input.status === "completed" &&
    input.execStatus === "completed" &&
    input.toolCalls === 0
  )
    return true
  if (input.showDetails) return false
  if (input.status !== "completed") return false
  return input.tool !== "exec"
}
