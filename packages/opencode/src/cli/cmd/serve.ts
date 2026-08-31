import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Log } from "../../util"
import { LLMServerTokens } from "../../llm-server/tokens"

/**
 * Advertise a just-started listener so `mimo llm-server issue` can print a real base_url.
 *
 * Same contract as the TUI worker (`cli/cmd/tui/worker.ts`): keyed by the project
 * directory this process serves, one file per pid, withdrawn before the socket goes
 * away. Without this, `issue` still mints a valid token but reports `base_url: null`
 * and `llm-server list` says nothing is serving the directory.
 */
export async function advertiseListeningServer(
  directory: string,
  server: { hostname: string; port: number; url: URL },
) {
  await LLMServerTokens.publish(directory, {
    pid: process.pid,
    hostname: server.hostname,
    port: server.port,
    url: server.url.toString(),
    started: Date.now(),
  })
}

export async function unadvertiseListeningServer(directory: string) {
  await LLMServerTokens.unpublish(directory)
}

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless mimocode server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    const isLoopback = opts.hostname === "127.0.0.1" || opts.hostname === "localhost" || opts.hostname === "::1"

    if (!isLoopback && !Flag.MIMOCODE_SERVER_PASSWORD && !opts.noAuth) {
      console.error("ERROR: Binding to non-loopback address without MIMOCODE_SERVER_PASSWORD is not allowed.")
      console.error("Set MIMOCODE_SERVER_PASSWORD or pass --no-auth to override (DANGEROUS).")
      await Log.exit(1)
    }

    if (!Flag.MIMOCODE_SERVER_PASSWORD) {
      console.log("Warning: MIMOCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }

    const server = await Server.listen(opts)
    console.log(`mimocode server listening on http://${server.hostname}:${server.port}`)

    // `mimo serve` has no --directory flag, so the project this process serves is cwd —
    // the same key `llm-server issue` looks up.
    const directory = process.cwd()
    await advertiseListeningServer(directory, server).catch((error) =>
      Log.Default.warn("failed to advertise server address", { error: String(error) }),
    )

    // Withdraw the advertisement before the socket goes away, so a reader sees
    // "nothing is serving" rather than a port that refuses connections. A crash skips
    // this, which is what the pid liveness check in `addresses` is for.
    const shutdown = async () => {
      await unadvertiseListeningServer(directory).catch(() => {})
      await server.stop()
    }
    process.once("SIGINT", () => {
      void shutdown().then(() => process.exit(0))
    })
    process.once("SIGTERM", () => {
      void shutdown().then(() => process.exit(0))
    })

    await new Promise(() => {})
    await shutdown()
  },
})
