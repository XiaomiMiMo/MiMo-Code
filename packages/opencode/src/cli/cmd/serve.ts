import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Log } from "../../util"

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

    // Server.listen publishes this process into the llm-server address registry
    // (cwd) and unpublishes on stop, so `mimo llm-server issue` can resolve base_url.
    const server = await Server.listen(opts)
    console.log(`mimocode server listening on http://${server.hostname}:${server.port}`)

    // Force-close: graceful stop waits on live SSE/WS streams, and Ctrl-C would hang.
    const shutdown = () => server.stop(true)
    const onSignal = () => {
      void shutdown()
        .then(() => process.exit(0))
        .catch(() => process.exit(1))
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)

    await new Promise(() => {})
  },
})
