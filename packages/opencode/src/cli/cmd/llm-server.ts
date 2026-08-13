import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { LLMServer } from "../../llm-server/server"
import { UI } from "../ui"

/**
 * Start a temporary OpenAI-compatible endpoint for the models this instance is
 * configured with.
 *
 * The point is to stop handing real provider keys to things that only need "a
 * model": a skill, a subprocess, or a script gets `--base-url` plus a throwaway
 * token, and the actual credential never leaves `Provider.Service`. Because the
 * token dies with the process, one server per task is the isolation boundary.
 */
export const LlmServerCommand = cmd({
  command: "llm-server",
  describe: "start a temporary OpenAI-compatible API for configured models",
  builder: (yargs: Argv) =>
    yargs
      .option("port", {
        type: "number",
        describe: "port to listen on (0 picks a free port)",
        default: 0,
      })
      .option("model", {
        type: "string",
        array: true,
        describe: "restrict this server to the given provider/model (repeatable)",
        default: [] as string[],
      })
      .option("token", {
        type: "string",
        describe: "use this bearer token instead of generating one",
      })
      .option("json", {
        type: "boolean",
        describe: "print connection details as JSON",
        default: false,
      }),
  handler: async (args) => {
    const server = await LLMServer.listen({
      port: args.port,
      directory: process.cwd(),
      // A caller-supplied token lets a parent process know the value before the
      // child prints anything; otherwise one is minted per process.
      token: args.token || LLMServer.generateToken(),
      models: args.model,
    })

    if (args.json) {
      // Deliberately machine-first: a wrapper reads one line, sets OPENAI_BASE_URL
      // and OPENAI_API_KEY from it, and never has to scrape prose.
      process.stdout.write(
        JSON.stringify({
          base_url: server.url,
          api_key: server.token,
          port: server.port,
          models: args.model.length > 0 ? args.model : "all",
        }) + "\n",
      )
    }

    if (!args.json) {
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "llm-server" + UI.Style.TEXT_NORMAL + " listening")
      UI.println(`  base_url  ${server.url}`)
      UI.println(`  api_key   ${server.token}`)
      UI.println(
        `  models    ${args.model.length > 0 ? args.model.join(", ") : "all configured models"}`,
      )
      UI.println("")
      UI.println("The token lives in memory only and is revoked when this process exits.")
    }

    const shutdown = () => {
      server.stop().finally(() => process.exit(0))
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)

    await new Promise(() => {})
  },
})
