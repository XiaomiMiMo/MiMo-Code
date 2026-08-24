import { Flag } from "@/flag/flag"

export type HarnessMode = "auto" | "codex" | "default"

function codexHarnessOverride(harness?: HarnessMode): boolean | undefined {
  if (harness === "codex") return true
  if (harness === "default") return false
  return undefined
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
  if (isGPTModel(...modelIDs)) return true
  return enabled || (codexHarnessOverride(harness) ?? (Flag.MIMOCODE_CODEX_MODE || usesMimoCodexMode(...modelIDs)))
}

export function usesMimoCodexMode(...values: Array<string | undefined>) {
  const ids = values.flatMap((value) => (value ? [value.toLowerCase()] : []))
  if (ids.some((id) => /(?:^|[/])mimo-v2\.5(?:-pro)?$/.test(id))) return false
  return ids.some((id) => /(?:^|[/_-])mimo(?:$|[/_.-])/.test(id))
}

export function usesGPTToolset(modelID: string, harness?: HarnessMode) {
  if (isGPTModel(modelID)) return true
  return codexHarnessOverride(harness) ?? (Flag.MIMOCODE_CODEX_MODE || usesMimoCodexMode(modelID))
}
