export const FREE_API_SUNSET_AT = Date.parse("2026-07-26T10:00:00.000Z")

export function isFreeApiSunset(now = Date.now()) {
  return now >= FREE_API_SUNSET_AT
}

export function isFreeApiModel(model: { providerID: string; modelID: string } | undefined) {
  return model?.providerID === "mimo" && model.modelID === "mimo-auto"
}
