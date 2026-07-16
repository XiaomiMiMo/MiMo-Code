import type { SessionStatus } from "@mimo-ai/sdk/v2"

type ModelRef = {
  providerID: string
  modelID: string
}

type RetryStatus = Extract<SessionStatus, { type: "retry" }> & Partial<ModelRef>

export function visiblePromptStatus(status: SessionStatus, model: ModelRef | undefined): SessionStatus {
  if (status.type !== "retry") return status

  const retry = status as RetryStatus
  if (!retry.providerID || !retry.modelID || !model) return status
  if (retry.providerID === model.providerID && retry.modelID === model.modelID) return status

  return { type: "idle" }
}
