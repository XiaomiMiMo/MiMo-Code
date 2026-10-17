import type { Effect } from "effect"
import type { ProviderID, ModelID } from "@/provider/schema"
import type { Interface as InboxInterface } from "./inbox"

export interface DefaultModelRef {
  defaultModel: () => Effect.Effect<{ providerID: ProviderID; modelID: ModelID }>
}

export const defaultModelRef: { current: DefaultModelRef | undefined } = { current: undefined }

export const inboxServiceRef: { current: InboxInterface | undefined } = { current: undefined }
