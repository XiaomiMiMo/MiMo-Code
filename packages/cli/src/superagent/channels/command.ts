import { execFile } from "node:child_process"

export type Command = (program: string, args: string[], input?: string, signal?: AbortSignal) => Promise<string>
export const command: Command = (program, args, input, signal) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      program,
      args,
      {
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        signal,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim().slice(0, 2000) || `${program} exited unsuccessfully`))
        else resolve(stdout)
      },
    )
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
  })
