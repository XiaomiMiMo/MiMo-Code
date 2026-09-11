import { createMemo } from "solid-js"
import { useKV } from "./kv"

export type VisualMode = "minimal" | "vivid"

export function resolveVisualMode(value: unknown): VisualMode {
  return value === "minimal" ? "minimal" : "vivid"
}

export function toggleVisualMode(value: unknown): VisualMode {
  return resolveVisualMode(value) === "vivid" ? "minimal" : "vivid"
}

export function visualMotionEnabled(mode: VisualMode, animationsEnabled: boolean) {
  return mode === "vivid" && animationsEnabled
}

export function useVisualMode() {
  const kv = useKV()
  const mode = createMemo(() => resolveVisualMode(kv.get("visual_mode", "vivid")))
  const animationsEnabled = createMemo(() => kv.get("animations_enabled", true) === true)
  return {
    mode,
    vivid: createMemo(() => mode() === "vivid"),
    motion: createMemo(() => visualMotionEnabled(mode(), animationsEnabled())),
  }
}
