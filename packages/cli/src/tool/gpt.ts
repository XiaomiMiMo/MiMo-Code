import { Flag } from "@/flag/flag"

export type HarnessMode = "auto" | "codex" | "default"

function codexHarnessOverride(harness?: HarnessMode): boolean | undefined {
  if (harness === "codex") return true
  if (harness === "default") return false
  return undefined
}

function usesCodexMode(harness: HarnessMode | undefined, ...modelIDs: Array<string | undefined>) {
  const mode = Flag.MIMOCODE_CODEX_MODE
  if (mode === false) return false
  if (isGPTModel(...modelIDs)) return true
  return codexHarnessOverride(harness) ?? mode ?? false
}

export function isGPTModel(...values: Array<string | undefined>) {
  const ids = values.flatMap((value) => (value ? [value.toLowerCase()] : []))
  if (ids.some((id) => id.includes("gpt-oss"))) return false
  return ids.some((id) => id.includes("gpt"))
}

export function isMcpToolSearchEnabled(
  enabled: boolean,
  harness: HarnessMode | undefined,
  ...modelIDs: Array<string | undefined>
) {
  return enabled || usesCodexMode(harness, ...modelIDs)
}

export function usesGPTToolset(
  modelID: string,
  harness?: HarnessMode,
  ...modelIDs: Array<string | undefined>
) {
  return usesCodexMode(harness, modelID, ...modelIDs)
}
