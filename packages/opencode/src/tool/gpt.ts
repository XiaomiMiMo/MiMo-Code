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
  return enabled || (codexHarnessOverride(harness) ?? Flag.MIMOCODE_CODEX_MODE)
}

export function isMimoModel(...values: Array<string | undefined>) {
  return values.some((value) => value && /(?:^|[/_-])mimo(?:$|[/_.-])/i.test(value))
}

export function usesMimoResponsesApi(...values: Array<string | undefined>) {
  const ids = values.flatMap((value) => (value ? [value.toLowerCase()] : []))
  return isMimoModel(...ids) && ids.some((id) => /(?:^|[/_.-])ptc(?:$|[/_.-])/.test(id))
}

export function usesGPTToolset(
  modelID: string,
  harness?: HarnessMode,
  ...modelIDs: Array<string | undefined>
) {
  const ids = [modelID, ...modelIDs]
  if (isGPTModel(...ids)) return true
  return codexHarnessOverride(harness) ?? Flag.MIMOCODE_CODEX_MODE
}
