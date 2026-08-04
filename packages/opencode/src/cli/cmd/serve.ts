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

    const server = await Server.listen(opts)
    console.log(`mimocode server listening on http://${server.hostname}:${server.port}`)

    await new Promise<void>((resolve) => {
      let shuttingDown = false
      const shutdown = async (signal: string) => {
        if (shuttingDown) return
        shuttingDown = true
        console.log(`\n[Server] Received ${signal}, gracefully shutting down...`)
        try {
          await server.stop()
        } catch (err) {
          console.error("[Server] Error during shutdown:", err)
        }
        resolve()
      }
      process.once("SIGINT", () => void shutdown("SIGINT"))
      process.once("SIGTERM", () => void shutdown("SIGTERM"))
    })
    process.exit(0)
  },
})
