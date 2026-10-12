import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../../", import.meta.url))
const dir = mkdtempSync(join(tmpdir(), "plugin-host-node-"))
const outfile = join(dir, "host-node.mjs")
const build = spawnSync(
  process.execPath,
  ["build", fileURLToPath(new URL("./fixtures/host-node.ts", import.meta.url)), "--target=node", "--outfile", outfile],
  { cwd, encoding: "utf8" },
)

for (const shim of [false, true]) {
  test(`Node build ${shim ? "with a partial Bun shim" : "without Bun"} loads only config-dir plugins`, () => {
    expect(build.status, build.stderr).toBe(0)
    const env: Record<string, string | undefined> = { ...process.env, BUN_SHIM: shim ? "1" : "" }
    delete env.MIMOCODE_ONLY_CONFIG_DIR_PLUGINS
    const run = spawnSync("node", [outfile], { cwd, encoding: "utf8", env })
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout.trim().split("\n").pop()!)).toEqual({ onlyConfigDir: true })
  })
}
