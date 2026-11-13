import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

test("one workspace daemon survives its launcher, is reused, and restarts with persisted Sessions", async () => {
  await using tmp = await tmpdir({ git: true })
  const home = path.join(tmp.path, "runtime")
  const entry = path.resolve(import.meta.dir, "../../src/index.ts")
  const preload = fileURLToPath(import.meta.resolve("@opentui/solid/preload"))
  const env = {
    ...process.env,
    MIMOCODE_HOME: home,
    MIMOCODE_DB: path.join(home, "tasks.db"),
    MIMOCODE_DISABLE_DEFAULT_PLUGINS: "true",
  }
  const cli = async (action: string) => {
    const proc = Bun.spawn(
      [process.execPath, "run", "--conditions=browser", "--preload", preload, entry, "daemon", action, tmp.path],
      { cwd: tmp.path, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`CLI failed: ${stderr}\n${stdout}`)
    return stdout
  }
  let pid: number | undefined
  try {
    const starts = await Promise.all([cli("start"), cli("start")])
    const records = starts.map((text) => JSON.parse(text.trim().split("\n").at(-1)!) as { pid: number; url: string })
    pid = records[0].pid
    expect(records[1].pid).toBe(pid)
    expect(JSON.parse((await cli("status")).trim()).pid).toBe(pid)
    const hash = createHash("sha256").update(tmp.path).digest("hex").slice(0, 20)
    // Locate the generated record through the same home layout used by the application.
    const { readdir } = await import("node:fs/promises")
    const find = async (dir: string): Promise<string | undefined> => {
      for (const file of await readdir(dir, { withFileTypes: true })) {
        const target = path.join(dir, file.name)
        if (file.name === "service.json" && dir.endsWith(hash)) return target
        if (file.isDirectory()) {
          const found = await find(target)
          if (found) return found
        }
      }
    }
    const recordPath = await find(home)
    expect(recordPath).toBeTruthy()
    const service = JSON.parse(await readFile(recordPath!, "utf8")) as { password: string; url: string }
    const headers = { Authorization: `Basic ${Buffer.from(`mimocode:${service.password}`).toString("base64")}` }
    const response = await fetch(`${service.url}superagent`, { headers })
    if (response.status !== 200)
      throw new Error(`Workspace request failed: ${response.status} ${await response.text()}`)
    expect(response.status).toBe(200)
    const first = (await response.json()) as { routerSessionId: string }
    await cli("stop")
    const end = Date.now() + 10000
    while (Date.now() < end && (await cli("status")).includes('"pid"')) await Bun.sleep(100)
    const restarted = JSON.parse((await cli("start")).trim().split("\n").at(-1)!) as { pid: number }
    pid = restarted.pid
    expect(pid).not.toBe(records[0].pid)
    const next = JSON.parse(await readFile(recordPath!, "utf8")) as { password: string; url: string }
    const state = await fetch(`${next.url}superagent`, {
      headers: { Authorization: `Basic ${Buffer.from(`mimocode:${next.password}`).toString("base64")}` },
    })
    expect(((await state.json()) as { routerSessionId: string }).routerSessionId).toBe(first.routerSessionId)
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {}
    }
  }
}, 60000)
