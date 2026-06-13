export type ModelRef = {
  providerID: string
  modelID: string
}

export function parseModelRef(value: string | undefined): ModelRef | undefined {
  if (!value) return undefined
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined
  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  }
}
