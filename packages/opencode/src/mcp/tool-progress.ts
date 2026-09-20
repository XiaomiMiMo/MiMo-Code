import { Log } from "../util"

export interface McpToolProgressContext {
  onMcpToolProgress: (meta: Record<string, unknown>) => Promise<unknown>
}

// Progress is client-only presentation metadata, never model-visible output.
export function toolPresentationProgress(context: unknown) {
  const callback =
    context &&
    typeof context === "object" &&
    "onMcpToolProgress" in context &&
    typeof context.onMcpToolProgress === "function"
      ? (context as McpToolProgressContext).onMcpToolProgress
      : undefined
  let pending = Promise.resolve()
  return {
    update(progress: unknown) {
      if (!callback || !progress || typeof progress !== "object" || !("_meta" in progress)) return
      const meta = progress._meta
      if (!meta || typeof meta !== "object" || !("mimo/toolSurface" in meta)) return
      const surface = meta["mimo/toolSurface"]
      if (!surface || typeof surface !== "object" || Array.isArray(surface)) return
      if (JSON.stringify(surface).length > 400_000) return
      pending = pending
        .then(() => callback({ "mimo/toolSurface": surface }))
        .then(() => undefined)
        .catch((error) => {
          Log.create({ service: "mcp" }).warn("tool presentation update failed", { error })
        })
    },
    drain: () => pending,
  }
}
