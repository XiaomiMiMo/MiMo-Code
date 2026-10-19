import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { assertFdsCredentials, assertTarballs, npmPackages, packLibrary, stableVersion, verify } from "./release"

const root = path.resolve(import.meta.dir, "..")
const git = (cwd: string) => new $.Shell().cwd(cwd)

async function fixture(versions: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "release-verify-"))
  await Promise.all(
    Object.entries(versions).map(async ([name, version]) => {
      await mkdir(path.join(dir, "packages", name), { recursive: true })
      await Bun.write(path.join(dir, "packages", name, "package.json"), JSON.stringify({ version }))
    }),
  )
  await git(dir)`git init -q -b main`
  await git(dir)`git -c user.name=test -c user.email=test@example.com commit -q --allow-empty -m base`
  await git(dir)`git add -A`
  await git(dir)`git -c user.name=test -c user.email=test@example.com commit -q -m release`
  await git(dir)`git update-ref refs/remotes/origin/main HEAD`
  return dir
}

const matching = { cli: "1.2.3", sdk: "1.2.3", plugin: "1.2.3", shared: "1.2.3" }

describe("stableVersion", () => {
  test("accepts MAJOR.MINOR.PATCH only", () => {
    expect(stableVersion("0.1.16")).toBe("0.1.16")
    for (const value of ["0.1", "01.2.3", "1.2.3-beta.1", "v1.2.3", undefined]) {
      expect(() => stableVersion(value)).toThrow()
    }
  })
})

describe("verify", () => {
  test("passes for a tagged main commit with matching package versions", async () => {
    const dir = await fixture(matching)
    await git(dir)`git tag v1.2.3`
    await verify("1.2.3", dir)
    await rm(dir, { recursive: true, force: true })
  })

  test("rejects a tag that does not point at HEAD", async () => {
    const dir = await fixture(matching)
    await git(dir)`git tag v1.2.3 HEAD~1`
    await expect(verify("1.2.3", dir)).rejects.toThrow("HEAD must be the commit tagged v1.2.3")
    await rm(dir, { recursive: true, force: true })
  })

  test("rejects a commit that is not on origin/main", async () => {
    const dir = await fixture(matching)
    await git(dir)`git update-ref refs/remotes/origin/main HEAD~1`
    await git(dir)`git tag v1.2.3`
    await expect(verify("1.2.3", dir)).rejects.toThrow("must point to a commit on origin/main")
    await rm(dir, { recursive: true, force: true })
  })

  test("names every package whose version differs from the tag", async () => {
    const dir = await fixture({ ...matching, sdk: "1.2.2" })
    await git(dir)`git tag v1.2.3`
    await expect(verify("1.2.3", dir)).rejects.toThrow("sdk@1.2.2")
    await rm(dir, { recursive: true, force: true })
  })
})

describe("packLibrary", () => {
  test.each(["sdk", "plugin"] as const)(
    "packs committed %s sources with dist exports and resolved dependencies",
    async (name) => {
      const dest = await mkdtemp(path.join(tmpdir(), "release-pack-"))
      const version = (await Bun.file(path.join(root, "packages", name, "package.json")).json()).version
      const status = () => $`git status --porcelain -- ${path.join("packages", name)}`.cwd(root).quiet().text()
      const before = await status()
      const file = await packLibrary(name, version, dest)
      const pkg = JSON.parse(await $`tar -xOzf ${file} package/package.json`.quiet().text())
      const entries = (await $`tar -tzf ${file}`.quiet().text()).split("\n")

      expect(pkg.name).toBe(`@mimo-ai/${name}`)
      expect(pkg.exports["."]).toEqual({ types: "./dist/index.d.ts", import: "./dist/index.js" })
      expect(JSON.stringify(pkg.dependencies)).not.toMatch(/workspace:|catalog:/)
      expect(entries).toContain("package/README.md")
      expect(entries).toContain("package/LICENSE")
      expect(entries.some((entry) => entry.endsWith(".tsbuildinfo"))).toBe(false)
      expect(await status()).toBe(before)
      await rm(dest, { recursive: true, force: true })
    },
    120_000,
  )
})

describe("assertTarballs", () => {
  const tarballName = (name: string, version: string) => `${name.slice(1).replace("/", "-")}-${version}.tgz`

  async function writeTarball(dir: string, name: string, version: string, meta: { name: string; version: string }) {
    const stage = path.join(dir, "stage")
    await mkdir(path.join(stage, "package"), { recursive: true })
    await Bun.write(
      path.join(stage, "package", "package.json"),
      JSON.stringify({ name: meta.name, version: meta.version }),
    )
    await $`tar -czf ${path.join(dir, tarballName(name, version))} -C ${stage} package`.quiet()
    await rm(stage, { recursive: true, force: true })
  }

  test("passes when every package tarball matches name and version", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "release-tarballs-"))
    for (const name of npmPackages) await writeTarball(dir, name, "1.2.3", { name, version: "1.2.3" })
    await assertTarballs("1.2.3", dir)
    await rm(dir, { recursive: true, force: true })
  })

  test("lists every missing tarball", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "release-tarballs-"))
    await writeTarball(dir, "@mimo-ai/sdk", "1.2.3", { name: "@mimo-ai/sdk", version: "1.2.3" })
    await expect(assertTarballs("1.2.3", dir)).rejects.toThrow("@mimo-ai/plugin: missing")
    await expect(assertTarballs("1.2.3", dir)).rejects.toThrow("@mimo-ai/cli: missing")
    await rm(dir, { recursive: true, force: true })
  })

  test("rejects tarball metadata that does not match the release version", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "release-tarballs-"))
    for (const name of npmPackages) await writeTarball(dir, name, "1.2.3", { name, version: "1.2.2" })
    await expect(assertTarballs("1.2.3", dir)).rejects.toThrow("expected @mimo-ai/sdk@1.2.3")
    await rm(dir, { recursive: true, force: true })
  })
})

describe("assertFdsCredentials", () => {
  test("requires both AK and SK before any publish stage", () => {
    expect(() => assertFdsCredentials({})).toThrow("MIMO_FDS_AK / MIMO_FDS_SK")
    expect(() => assertFdsCredentials({ MIMO_FDS_AK: "ak" })).toThrow("MIMO_FDS_AK / MIMO_FDS_SK")
    expect(() => assertFdsCredentials({ MIMO_FDS_SK: "sk" })).toThrow("MIMO_FDS_AK / MIMO_FDS_SK")
    expect(() => assertFdsCredentials({ MIMO_FDS_AK: "ak", MIMO_FDS_SK: "sk" })).not.toThrow()
  })
})
