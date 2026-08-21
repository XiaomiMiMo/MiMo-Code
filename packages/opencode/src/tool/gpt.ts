import { Flag } from "@/flag/flag"

export function isGPTModel(...values: Array<string | undefined>) {
  const ids = values.flatMap((value) => (value ? [value.toLowerCase()] : []))
  if (ids.some((id) => id.includes("gpt-oss"))) return false
  return ids.some((id) => id.includes("gpt"))
}

export function isMcpToolSearchEnabled(enabled: boolean, codexMode: boolean | undefined, ...modelIDs: Array<string | undefined>) {
  return Flag.MIMOCODE_CODEX_MODE || codexMode === true || (codexMode !== false && (enabled || isGPTModel(...modelIDs) || usesMimoCodexMode(...modelIDs)))
}

export function usesMimoCodexMode(...values: Array<string | undefined>) {
  const ids = values.flatMap((value) => (value ? [value.toLowerCase()] : []))
  if (ids.some((id) => /(?:^|[/])mimo-v2\.5(?:-pro)?$/.test(id))) return false
  return ids.some((id) => /(?:^|[/_-])mimo(?:$|[/_.-])/.test(id))
}

export function usesGPTToolset(modelID: string, codexMode?: boolean) {
  return (
    Flag.MIMOCODE_CODEX_MODE ||
    codexMode === true ||
    (codexMode !== false && ((modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")) ||
    usesMimoCodexMode(modelID)))
  )
}
