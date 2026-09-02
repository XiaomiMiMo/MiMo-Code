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
      // Private HTTP shim for this ACP session's SDK client — not a task-token host.
      // Advertising would hand `issue`/`list` a base_url that only works for callers
      // already inside this process's directory scope.
      const server = await Server.listen({ ...opts, advertise: false })

      const sdk = createOpencodeClient({
        baseUrl: `http://${server.hostname}:${server.port}`,
      })

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
      let stdinListeners: (() => void)[] = []
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          const onData = (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk))
          }
          const onEnd = () => controller.close()
          const onError = (err: Error) => controller.error(err)
          process.stdin.on("data", onData)
          process.stdin.on("end", onEnd)
          process.stdin.on("error", onError)
          stdinListeners = [
            () => process.stdin.off("data", onData),
            () => process.stdin.off("end", onEnd),
            () => process.stdin.off("error", onError),
          ]
        },
        cancel() {
          for (const off of stdinListeners) off()
          stdinListeners = []
        },
      })

      const stream = ndJsonStream(input, output)
      const agent = await ACP.init({ sdk })

      new AgentSideConnection((conn) => {
        return agent.create(conn, { sdk })
      }, stream)

      log.info("setup connection")
      process.stdin.resume()
      await new Promise<void>((resolve, reject) => {
        const onEnd = () => {
          process.stdin.off("error", onError)
          resolve()
        }
        const onError = (err: Error) => {
          process.stdin.off("end", onEnd)
          reject(err)
        }
        process.stdin.on("end", onEnd)
        process.stdin.on("error", onError)
      })
    })
  },
})
