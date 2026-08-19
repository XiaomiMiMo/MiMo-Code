import { Flag } from "@/flag/flag"

export function isGPTModel(...values: Array<string | undefined>) {
  const ids = values.flatMap((value) => (value ? [value.toLowerCase()] : []))
  if (ids.some((id) => id.includes("gpt-oss"))) return false
  return ids.some((id) => id.includes("gpt"))
}

export function isMcpToolSearchEnabled(enabled: boolean, ...modelIDs: Array<string | undefined>) {
  return Flag.MIMOCODE_CODEX_MODE || enabled || isGPTModel(...modelIDs) || isMimoModel(...modelIDs)
}

export function isMimoModel(...values: Array<string | undefined>) {
  return values.some((value) => value && /(?:^|[/_-])mimo(?:$|[/_.-])/i.test(value))
}

export function usesGPTToolset(modelID: string) {
  return (
    Flag.MIMOCODE_CODEX_MODE ||
    (modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")) ||
    isMimoModel(modelID)
  )
}
