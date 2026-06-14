import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const INSTALL_URL = "https://raw.githubusercontent.com/SheriAkhtamov/Devora/main/install"
const INSTALL_PATH = join(homedir(), ".devora", "bin", "devora")

export type InstallCliRunner = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv },
) => Promise<void>

export function installCliCommand() {
  return {
    command: "bash",
    args: ["-lc", `curl -fsSL ${INSTALL_URL} | bash`],
  }
}

export async function installCli(run: InstallCliRunner = runInstaller) {
  const command = installCliCommand()
  await run(command.command, command.args, { env: { ...process.env } })
  return INSTALL_PATH
}

function runInstaller(command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { env: opts.env, maxBuffer: 1024 * 1024 * 8 }, (error, _stdout, stderr) => {
      if (!error) {
        resolve()
        return
      }

      const details = stderr.trim()
      reject(new Error(details || error.message, { cause: error }))
    })
  })
}
