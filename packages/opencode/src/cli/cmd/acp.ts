import { Log } from "@/util"
import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ACP } from "@/acp/agent"
import { Server } from "@/server/server"
import { createOpencodeClient } from "@mimo-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"

const log = Log.create({ service: "acp-command" })

export const AcpCommand = cmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: async (args) => {
    process.env.MIMOCODE_CLIENT = "acp"
    await bootstrap(process.cwd(), async () => {
      const opts = await resolveNetworkOptions(args)
      const server = await Server.listen(opts)

      const sdk = createOpencodeClient({
        baseUrl: `http://${server.hostname}:${server.port}`,
      })

      // Wait for providers to be fully loaded after potential DB migration.
      // Without this, the first request may race with provider initialization
      // and fall back to Provider.sort() which picks a paid model.
      let providersReady = false
      for (let i = 0; i < 10; i++) {
        const resp = await sdk.config.providers({ directory: args.cwd }, { throwOnError: false })
        if (resp.data?.providers?.length) {
          providersReady = true
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!providersReady) {
        log.warn("providers not loaded within 5s, proceeding anyway")
      }

      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            process.stdout.write(chunk, (err) => {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        },
      })
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          process.stdin.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk))
          })
          process.stdin.on("end", () => controller.close())
          process.stdin.on("error", (err) => controller.error(err))
        },
      })

      const stream = ndJsonStream(input, output)
      const agent = await ACP.init({ sdk })

      new AgentSideConnection((conn) => {
        return agent.create(conn, { sdk })
      }, stream)

      log.info("setup connection")
      process.stdin.resume()
      await new Promise((resolve, reject) => {
        process.stdin.on("end", resolve)
        process.stdin.on("error", reject)
      })
    })
  },
})
