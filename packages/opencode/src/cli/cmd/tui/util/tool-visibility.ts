export function shouldHideTool(input: { showDetails: boolean; tool: string; status: string }) {
  if (input.showDetails) return false
  if (input.status !== "completed") return false
  return input.tool !== "exec"
}
