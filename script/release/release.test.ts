import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { clean, command, preflight, root, run } from "./context"
import { notesBaseline } from "./github"
import {
  advanceLatest,
  assetAction,
  compareVersions,
  digest,
  platforms,
  publicationOrder,
  registryValue,
  sameBuild,
  stableVersion,
  tagVersion,
  validateManifest,
  verifyBytes,
  verifyFiles,
  type Artifact,
  type Manifest,
} from "./manifest"
import { verifyIntegrity } from "./npm"
import { transformExports } from "./pack"

const bytes = new TextEncoder().encode("example release artifact")
const commit = "a".repeat(40)
const version = "0.1.99"
const folders: string[] = []
const environment = {
  MIMOCODE_CHANNEL: process.env.MIMOCODE_CHANNEL,
  MIMOCODE_BUMP: process.env.MIMOCODE_BUMP,
  MIMOCODE_SKIP_VERSION_CHECK: process.env.MIMOCODE_SKIP_VERSION_CHECK,
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
  for (const [key, value] of Object.entries(environment)) {
    if (value == null) delete process.env[key]
    if (value != null) process.env[key] = value
  }
})

function artifact(file: string, kind: Artifact["kind"], name?: string): Artifact {
  return {
    file,
    kind,
    size: bytes.length,
    sha256: digest(bytes),
    ...(name ? { name, integrity: `sha512-${digest(bytes, "sha512")}` } : {}),
  }
}

function manifest(): Manifest {
  return {
    schema: 1,
    version,
    tag: `v${version}`,
    commit,
    bun: "1.3.14",
    models: { source: "https://example.com/api.json", sha256: digest(bytes) },
    artifacts: [
      ...platforms.map((name) => artifact(`${name}.${name.includes("linux") ? "tar.gz" : "zip"}`, "archive")),
      ...["sdk", "plugin", ...platforms, "cli"].map((name) => artifact(`${name}.tgz`, "npm", `@mimo-ai/${name}`)),
      artifact("models.json", "models"),
    ],
  }
}

async function directory() {
  const folder = await mkdtemp(path.join(tmpdir(), "release-example-"))
  folders.push(folder)
  return folder
}

async function repository(options: { annotated?: boolean; lockVersion?: string; packageVersion?: string } = {}) {
  const cwd = await directory()
  const remote = await directory()
  await run(["git", "init", "--initial-branch=main"], cwd)
  await run(["git", "config", "user.email", "test@example.com"], cwd)
  await run(["git", "config", "user.name", "Example"], cwd)
  await Bun.write(path.join(cwd, "package.json"), JSON.stringify({ packageManager: `bun@${Bun.version}` }))
  await Promise.all(
    ["cli", "sdk", "plugin", "shared"].map((name) =>
      Bun.write(
        path.join(cwd, `packages/${name}/package.json`),
        JSON.stringify({ version: options.packageVersion ?? version }),
      ),
    ),
  )
  await Bun.write(
    path.join(cwd, "bun.lock"),
    JSON.stringify({
      workspaces: Object.fromEntries(
        ["cli", "sdk", "plugin", "shared"].map((name) => [
          `packages/${name}`,
          { version: options.lockVersion ?? version },
        ]),
      ),
    }),
  )
  await run(["git", "add", "."], cwd)
  await run(["git", "commit", "-m", "Example release"], cwd)
  await run(["git", "tag", ...(options.annotated ? ["-a", "-m", "Example tag"] : []), `v${version}`], cwd)
  await run(["git", "init", "--bare"], remote)
  await run(["git", "remote", "add", "origin", remote], cwd)
  await run(["git", "push", "origin", "main", "--tags"], cwd)
  process.env.MIMOCODE_CHANNEL = "latest"
  delete process.env.MIMOCODE_BUMP
  delete process.env.MIMOCODE_SKIP_VERSION_CHECK
  return { cwd, remote }
}

describe("stable releases", () => {
  test("only accepts exact stable versions and tags", () => {
    expect(stableVersion(version)).toBe(version)
    expect(tagVersion(`v${version}`)).toBe(version)
    for (const value of [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2",
      "1.2.3.4",
      "1.2.3-beta.1",
      "1.2.3+build",
      "v1.2.3",
      "1.2.3\n",
    ]) {
      expect(() => stableVersion(value)).toThrow()
    }
    expect(() => tagVersion("1.2.3")).toThrow()
    expect(() => tagVersion("vv1.2.3")).toThrow()
  })

  test("compares numeric segments and never downgrades latest", () => {
    expect(compareVersions("0.10.0", "0.9.99")).toBe(1)
    expect(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBe(1)
    expect(advanceLatest(undefined, version)).toBe(true)
    expect(advanceLatest("0.1.98", version)).toBe(true)
    expect(advanceLatest(version, version)).toBe(false)
    expect(advanceLatest("0.2.0", version)).toBe(false)
    expect(() => advanceLatest("next", version)).toThrow()
  })

  test.each([false, true])("validates existing remote tags (annotated=%s)", async (annotated) => {
    const fixture = await repository({ annotated })
    expect(await preflight(version, fixture.cwd)).toEqual({
      version,
      tag: `v${version}`,
      commit: await run(["git", "rev-parse", "HEAD"], fixture.cwd),
    })
  })

  test("rejects dirty or untracked input", async () => {
    const fixture = await repository()
    await Bun.write(path.join(fixture.cwd, "uncommitted.ts"), "export {}")
    await expect(clean(fixture.cwd)).rejects.toThrow("clean checkout")
  })

  test("rejects detached commits outside main", async () => {
    const fixture = await repository()
    await run(["git", "checkout", "-b", "feat/example"], fixture.cwd)
    await run(["git", "commit", "--allow-empty", "-m", "Unmerged example"], fixture.cwd)
    await run(["git", "tag", "-f", `v${version}`], fixture.cwd)
    await expect(preflight(version, fixture.cwd)).rejects.toThrow("merge-base failed")
  })

  test("rejects local tags that disagree with the remote", async () => {
    const fixture = await repository()
    await run(["git", "commit", "--allow-empty", "-m", "Later example"], fixture.cwd)
    await run(["git", "tag", "-f", `v${version}`], fixture.cwd)
    await run(["git", "push", "origin", "main"], fixture.cwd)
    await expect(preflight(version, fixture.cwd)).rejects.toThrow("remote tag")
  })

  test.each([{ lockVersion: "0.1.98" }, { packageVersion: "0.1.98" }])(
    "rejects uncommitted version preparation mistakes %j",
    async (options) => {
      const fixture = await repository(options)
      await expect(preflight(version, fixture.cwd)).rejects.toThrow("must both equal")
    },
  )

  test("rejects legacy bypass environment variables", async () => {
    const fixture = await repository()
    process.env.MIMOCODE_SKIP_VERSION_CHECK = "1"
    await expect(preflight(version, fixture.cwd)).rejects.toThrow("forbidden")
    delete process.env.MIMOCODE_SKIP_VERSION_CHECK
    process.env.MIMOCODE_BUMP = "patch"
    await expect(preflight(version, fixture.cwd)).rejects.toThrow("forbidden")
  })
})

describe("immutable release artifacts", () => {
  test("preserves the generated comparison baseline when a draft has no manifest yet", () => {
    expect(
      notesBaseline(
        "Example PR list\n**Full Changelog**: https://github.com/example/repo/compare/v0.1.98...v0.1.99",
        "example/repo",
        "v0.1.99",
      ),
    ).toBe("v0.1.98")
    expect(notesBaseline("Example first release", "example/repo", "v0.1.99")).toBeNull()
    expect(
      notesBaseline("https://github.com/example/repo/compare/v0.1.97...v0.1.98", "example/repo", "v0.1.99"),
    ).toBeNull()
  })

  test("legacy scoped entry points fail before starting publication", async () => {
    const results = await Promise.all(
      [
        "packages/cli/script/publish.ts",
        "packages/sdk/script/publish.ts",
        "packages/plugin/script/publish.ts",
        "script/version.ts",
      ].map((file) => command([process.execPath, path.join(root, file)])),
    )
    for (const result of results) {
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("is disabled. Use bun script/release.ts --stage")
    }
  })
  test("validates the complete CLI and npm set", () => {
    expect(validateManifest(manifest(), version, commit).artifacts).toHaveLength(28)
    expect(() => validateManifest(manifest(), "0.1.98", commit)).toThrow("does not match")
    expect(() => validateManifest(manifest(), version, "b".repeat(40))).toThrow("does not match")
  })

  test("rejects missing platforms, duplicate paths and traversal", () => {
    const incomplete = manifest()
    incomplete.artifacts.pop()
    expect(() => validateManifest(incomplete, version, commit)).toThrow("all 12 archives")
    const duplicate = manifest()
    duplicate.artifacts[0].file = duplicate.artifacts[1].file
    expect(() => validateManifest(duplicate, version, commit)).toThrow("duplicate")
    const traversal = manifest()
    traversal.artifacts[0].file = "../example.zip"
    expect(() => validateManifest(traversal, version, commit)).toThrow("Invalid")
  })

  test("publishes SDK then plugin then every platform before the wrapper", () => {
    const order = publicationOrder(manifest().artifacts.toReversed()).map((item) => item.name)
    expect(order.slice(0, 2)).toEqual(["@mimo-ai/sdk", "@mimo-ai/plugin"])
    expect(order.slice(2, -1)).toEqual(platforms.map((name) => `@mimo-ai/${name}`))
    expect(order.at(-1)).toBe("@mimo-ai/cli")
  })

  test("accepts notes enrichment and rejects build changes", () => {
    const saved = manifest()
    sameBuild(saved, { ...saved, notes: { baseline: "v0.1.98", body: "Example PR list" } })
    expect(() => sameBuild(saved, { ...saved, bun: "1.3.15" })).toThrow("different build")
  })

  test("replaces conflicts only in unpublished drafts", () => {
    const saved = artifact("example.zip", "archive")
    expect(assetAction(saved, bytes, false)).toBe("reuse")
    expect(assetAction(saved, new TextEncoder().encode("changed"), true)).toBe("replace")
    expect(() => assetAction(saved, new TextEncoder().encode("changed"), false)).toThrow("Published artifact")
  })

  test("checks real local files and npm integrity", async () => {
    const folder = await directory()
    const saved = manifest()
    await Promise.all(saved.artifacts.map((item) => Bun.write(path.join(folder, item.file), bytes)))
    await verifyFiles(folder, saved)
    await Bun.write(path.join(folder, saved.artifacts[0].file), "changed bytes")
    await expect(verifyFiles(folder, saved)).rejects.toThrow("content conflict")
    const packed = artifact("example.tgz", "npm", "@mimo-ai/sdk")
    verifyBytes(packed, bytes)
    verifyIntegrity(packed, packed.integrity)
    expect(() => verifyIntegrity(packed, "sha512-different")).toThrow("different integrity")
  })

  test("only E404 allows publishing an absent npm version", () => {
    expect(
      registryValue({ exitCode: 1, stdout: JSON.stringify({ error: { code: "E404" } }), stderr: "" }),
    ).toBeUndefined()
    expect(registryValue({ exitCode: 0, stdout: '"sha512-example"', stderr: "" })).toBe("sha512-example")
    for (const code of ["E401", "E403", "ETIMEDOUT", "ECONNRESET"]) {
      expect(() => registryValue({ exitCode: 1, stdout: JSON.stringify({ error: { code } }), stderr: "" })).toThrow(
        "lookup failed",
      )
    }
    expect(() => registryValue({ exitCode: 0, stdout: "", stderr: "" })).toThrow("no metadata")
    expect(() => registryValue({ exitCode: 1, stdout: "not json", stderr: "" })).toThrow()
  })

  test("maps committed TypeScript exports to compiled declarations and JavaScript", () => {
    expect(transformExports({ ".": "./src/index.ts", "./nested": { node: "./src/nested.ts" } })).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./nested": { node: { types: "./dist/nested.d.ts", import: "./dist/nested.js" } },
    })
  })
})
