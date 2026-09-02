import { Log } from "../util"

const log = Log.create({ service: "acp-command" })

/**
 * Wait for at least one provider to be loaded.
 * Returns true if providers loaded, false if timed out.
 */
export async function waitForProviders(
  poll: () => Promise<{ data?: { providers?: unknown[] } }>,
  opts: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const { maxAttempts = 10, intervalMs = 500 } = opts
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await poll()
      if (resp.data?.providers?.length) return true
    } catch {
      // SDK/network errors during startup are expected (e.g. DB migration in progress)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  log.warn("providers not loaded within timeout, proceeding anyway")
  return false
}
