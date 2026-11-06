import { cmd } from "./cmd"
import * as Daemon from "@/server/daemon"
import path from "node:path"
import { realpath } from "node:fs/promises"
export const DaemonCommand = cmd({
  command: "daemon <action> [project]",
  describe: "manage this project's background MiMo Server",
  builder: (yargs) =>
    yargs
      .positional("action", { type: "string", choices: ["start", "status", "stop"], demandOption: true })
      .positional("project", { type: "string", describe: "project directory (defaults to cwd)" }),
  handler: async (args) => {
    const directory = await realpath(path.resolve(args.project ?? process.cwd()))
    if (args.action === "stop") {
      console.log((await Daemon.stop(directory)) ? "Stopping background MiMo Server" : "No background MiMo Server")
      return
    }
    const service = args.action === "start" ? await Daemon.ensure(directory) : await Daemon.status(directory)
    console.log(
      service
        ? JSON.stringify({ pid: service.pid, url: service.url, directory: service.directory })
        : "No background MiMo Server",
    )
  },
})
