import { createOpencodeClient } from "@mimo-ai/sdk/v2"
import type { OpencodeClient } from "@mimo-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

export type WorkspaceID = string & { readonly __workspaceBrand: unique symbol }

export const asWorkspaceID = (value: string | undefined | null): WorkspaceID => {
  return (value ?? "") as unknown as WorkspaceID
}

const NO_WORKSPACE = asWorkspaceID("")

type Client = OpencodeClient

type PoolEntry = {
  client: Client
  refs: number
}

export const { use: useWorkspaceClients, provider: WorkspaceClientsProvider } = createSimpleContext({
  name: "WorkspaceClients",
  init: () => {
    const sdk = useSDK()
    const entries = new Map<WorkspaceID, PoolEntry>()

    const buildClient = (id: WorkspaceID): Client => {
      if (id === NO_WORKSPACE) return sdk.client
      return createOpencodeClient({
        baseUrl: sdk.url,
        directory: sdk.directory,
        experimental_workspaceID: id,
        fetch: sdk.fetch,
      })
    }

    const pool = {
      acquire(id: WorkspaceID) {
        const existing = entries.get(id)
        if (existing) {
          existing.refs += 1
          return existing.client
        }
        const entry: PoolEntry = { client: buildClient(id), refs: 1 }
        entries.set(id, entry)
        return entry.client
      },
      release(id: WorkspaceID) {
        const existing = entries.get(id)
        if (!existing) return
        existing.refs -= 1
        if (existing.refs <= 0) {
          entries.delete(id)
        }
      },
      size() {
        return entries.size
      },
    }

    return {
      pool,
      clientFor(id: WorkspaceID | undefined | null): Client {
        if (!id || id === NO_WORKSPACE) return sdk.client
        const existing = entries.get(id)
        if (existing) return existing.client
        return buildClient(id)
      },
    }
  },
})

export type WorkspaceClients = ReturnType<typeof useWorkspaceClients>
