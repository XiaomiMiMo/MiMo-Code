import path from "node:path"
import { parseConfigFileTextToJson } from "typescript"
import { stableVersion } from "./manifest"

export const root = path.resolve(import.meta.dir, "../..")
export const directory = path.join(root, "dist/release")

export async function command(args: string[], cwd = root, env = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

export async function run(args: string[], cwd = root, env = process.env) {
  const result = await command(args, cwd, env)
  if (result.exitCode !== 0) throw new Error(`${args[0]} ${args[1]} failed (${result.exitCode}): ${result.stderr}`)
  return result.stdout.trim()
}

export function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export async function clean(cwd = root) {
  if (await run(["git", "status", "--porcelain", "--untracked-files=normal"], cwd)) {
    throw new Error("Release requires a clean checkout of committed code")
  }
}

export async function preflight(version: string, cwd = root) {
  stableVersion(version)
  if (process.env.MIMOCODE_BUMP || process.env.MIMOCODE_SKIP_VERSION_CHECK) {
    throw new Error("Version bump and version-check overrides are forbidden during release")
  }
  if (process.env.MIMOCODE_CHANNEL !== "latest") throw new Error("Release requires MIMOCODE_CHANNEL=latest")
  await clean(cwd)
  const tag = `v${version}`
  const commit = await run(["git", "rev-parse", "HEAD"], cwd)
  if ((await run(["git", "rev-parse", `refs/tags/${tag}^{commit}`], cwd)) !== commit) {
    throw new Error(`HEAD must be the commit referenced by refs/tags/${tag}`)
  }
  await run(["git", "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"], cwd)
  const refs = await run(["git", "ls-remote", "--exit-code", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], cwd)
  const remote = refs.split("\n").map((line) => line.split(/\s+/))
  if ((remote.find((item) => item[1].endsWith("^{}")) ?? remote[0])[0] !== commit) {
    throw new Error(`The remote tag ${tag} does not resolve to HEAD`)
  }
  const pkg = await Bun.file(path.join(cwd, "package.json")).json()
  if (pkg.packageManager !== `bun@${Bun.version}`) throw new Error(`Release requires exactly ${pkg.packageManager}`)
  const lock = parseConfigFileTextToJson("bun.lock", await Bun.file(path.join(cwd, "bun.lock")).text())
  if (lock.error) throw new Error("Cannot parse bun.lock")
  await Promise.all(
    ["cli", "sdk", "plugin", "shared"].map(async (name) => {
      const workspace = `packages/${name}`
      if (
        (await Bun.file(path.join(cwd, workspace, "package.json")).json()).version !== version ||
        lock.config.workspaces[workspace]?.version !== version
      ) {
        throw new Error(`${workspace} and its bun.lock workspace version must both equal ${version}`)
      }
    }),
  )
  return { version, tag, commit }
}

export type Release = Awaited<ReturnType<typeof preflight>>
