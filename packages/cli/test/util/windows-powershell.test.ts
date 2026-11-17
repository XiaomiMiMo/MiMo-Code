import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs/promises"
import path from "path"
import { extractZip } from "../../src/util/archive"
import { WindowsPowerShell } from "../../src/util/windows-powershell"
import { tmpdir } from "../fixture/fixture"

const win = process.platform === "win32"
const saved = { PATH: process.env.PATH, PSModulePath: process.env.PSModulePath }

afterEach(() => {
  process.env.PATH = saved.PATH
  if (saved.PSModulePath === undefined) delete process.env.PSModulePath
  else process.env.PSModulePath = saved.PSModulePath
})

// A pwsh parent's PSModulePath with an Archive module that only works on .NET
// Core placed first, as reported in #2805.
async function inheritedPs7ModulePath(dir: string) {
  const mod = path.join(dir, "ps7-modules", "Microsoft.PowerShell.Archive")
  await fs.mkdir(mod, { recursive: true })
  await Bun.write(
    path.join(mod, "Microsoft.PowerShell.Archive.psm1"),
    "function Expand-Archive { param([string]$Path, [string]$DestinationPath, [switch]$Force); throw 'PS7-only Archive module loaded' }",
  )
  return [path.join(dir, "ps7-modules"), saved.PSModulePath].filter(Boolean).join(";")
}

async function zipWith(dir: string, name: string, text: string) {
  const src = path.join(dir, "src")
  await fs.mkdir(src, { recursive: true })
  await Bun.write(path.join(src, name), text)
  const zip = path.join(dir, "a.zip")
  expect(Bun.spawnSync(["tar", "-a", "-c", "-f", zip, "-C", src, name]).exitCode).toBe(0)
  return zip
}

describe("WindowsPowerShell.env", () => {
  test("unsets PSModulePath and keeps extra variables", () => {
    process.env.PSModulePath = "/tmp/example/modules"
    const env = WindowsPowerShell.env({ EXTRA: "1" })
    expect(env.EXTRA).toBe("1")
    expect("PSModulePath" in env).toBe(true)
    expect(env.PSModulePath).toBeUndefined()
  })
})

describe.skipIf(!win)("WindowsPowerShell.executable", () => {
  test("resolves Windows PowerShell without relying on PATH", () => {
    process.env.PATH = (saved.PATH ?? "")
      .split(";")
      .filter((p) => !/WindowsPowerShell/i.test(p))
      .join(";")
    const exe = WindowsPowerShell.executable()
    expect(path.isAbsolute(exe)).toBe(true)
    expect(path.basename(exe).toLowerCase()).toBe("powershell.exe")
  })

  test("child does not load modules from an inherited pwsh PSModulePath", async () => {
    await using tmp = await tmpdir()
    process.env.PSModulePath = await inheritedPs7ModulePath(tmp.path)
    // Same merge production uses: child_process drops the undefined PSModulePath.
    const proc = spawnSync(
      WindowsPowerShell.executable(),
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-Command Expand-Archive).Module.ModuleBase"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...WindowsPowerShell.env() } },
    )
    expect(proc.stdout).toContain("Archive")
    expect(proc.stdout).not.toContain("ps7-modules")
  })
})

describe.skipIf(!win)("extractZip", () => {
  test("ignores a PowerShell 7 Archive module inherited from a pwsh parent", async () => {
    await using tmp = await tmpdir()
    const zip = await zipWith(tmp.path, "a.txt", "hello")
    process.env.PSModulePath = await inheritedPs7ModulePath(tmp.path)
    const out = path.join(tmp.path, "out")
    await extractZip(zip, out)
    expect(await Bun.file(path.join(out, "a.txt")).text()).toBe("hello")
  })

  test("works when WindowsPowerShell is missing from PATH", async () => {
    await using tmp = await tmpdir()
    const zip = await zipWith(tmp.path, "a.txt", "hello")
    process.env.PATH = (saved.PATH ?? "")
      .split(";")
      .filter((p) => !/WindowsPowerShell/i.test(p))
      .join(";")
    const out = path.join(tmp.path, "out")
    await extractZip(zip, out)
    expect(await Bun.file(path.join(out, "a.txt")).text()).toBe("hello")
  })
})
