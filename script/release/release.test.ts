import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { clean, command, preflight, root, run } from "./context"
import { github, githubCommand } from "./github"
import {
  digest,
  platforms,
  publicationOrder,
  stableVersion,
  tagVersion,
  validateManifest,
  verifyBytes,
  verifyFiles,
  type Artifact,
  type Manifest,
} from "./manifest"
import { npm, npmCommands } from "./npm"
import { transformExports } from "./pack"

const bytes = new TextEncoder().encode("example release artifact")
const commit = "a".repeat(40)
const version = "0.1.99"
const folders: string[] = []
const environment = {
  MIMOCODE_CHANNEL: process.env.MIMOCODE_CHANNEL,
  MIMOCODE_BUMP: process.env.MIMOCODE_BUMP,
  MIMOCODE_SKIP_VERSION_CHECK: process.env.MIMOCODE_SKIP_VERSION_CHECK,
  GH_REPO: process.env.GH_REPO,
  GH_TOKEN: process.env.GH_TOKEN,
  NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
  PATH: process.env.PATH,
  RELEASE_TEST_LOG: process.env.RELEASE_TEST_LOG,
  RELEASE_TEST_FAIL: process.env.RELEASE_TEST_FAIL,
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

  test("checks real local files and npm integrity", async () => {
    const folder = await directory()
    const saved = manifest()
    await Promise.all(saved.artifacts.map((item) => Bun.write(path.join(folder, item.file), bytes)))
    await verifyFiles(folder, saved)
    await Bun.write(path.join(folder, saved.artifacts[0].file), "changed bytes")
    await expect(verifyFiles(folder, saved)).rejects.toThrow("content conflict")
    const packed = artifact("example.tgz", "npm", "@mimo-ai/sdk")
    verifyBytes(packed, bytes)
    expect(() => verifyBytes({ ...packed, integrity: "sha512-different" }, bytes)).toThrow("integrity conflict")
  })

  test("maps committed TypeScript exports to compiled declarations and JavaScript", () => {
    expect(transformExports({ ".": "./src/index.ts", "./nested": { node: "./src/nested.ts" } })).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./nested": { node: { types: "./dist/nested.d.ts", import: "./dist/nested.js" } },
    })
  })
})

async function publisher(name: "gh" | "npm") {
  const cwd = await directory()
  const file = path.join(cwd, name)
  await Bun.write(
    file,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(args) + "\\n")
if (process.env.RELEASE_TEST_FAIL && args.some((arg) => arg.includes(process.env.RELEASE_TEST_FAIL))) {
  console.error("example publication conflict")
  process.exit(1)
}
`,
  )
  await chmod(file, 0o755)
  process.env.PATH = `${cwd}${path.delimiter}${environment.PATH ?? ""}`
  process.env.RELEASE_TEST_LOG = path.join(cwd, "commands.jsonl")
  delete process.env.RELEASE_TEST_FAIL
  process.env.GH_REPO = "example/repo"
  process.env.GH_TOKEN = "example-token"
  process.env.NODE_AUTH_TOKEN = "example-token"
  return async () =>
    (await Bun.file(path.join(cwd, "commands.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
}

describe("normal publication commands", () => {
  test("creates an existing-tag GitHub release with generated notes and every artifact", async () => {
    const commands = await publisher("gh")
    const saved = manifest()
    const expected = { version, tag: saved.tag, commit }
    await github(expected, saved)
    const recorded = await commands()
    expect(recorded).toEqual([githubCommand(expected, saved, "example/repo").slice(1)])
    expect(recorded[0].slice(0, 8)).toEqual([
      "release",
      "create",
      "v0.1.99",
      "--verify-tag",
      "--generate-notes",
      "--title",
      "v0.1.99",
      "--repo",
    ])
    expect(recorded[0].slice(9).map((file) => path.basename(file))).toEqual([
      "manifest.json",
      ...saved.artifacts.map((item) => item.file),
    ])
    expect(recorded[0]).not.toContain("--clobber")
  })

  test("reports an existing release conflict without attempting automatic repair", async () => {
    const commands = await publisher("gh")
    process.env.RELEASE_TEST_FAIL = "create"
    await expect(github({ version, tag: `v${version}`, commit }, manifest())).rejects.toThrow("publication conflict")
    expect(await commands()).toHaveLength(1)
  })

  test("publishes the 15 prepacked npm packages sequentially", async () => {
    const commands = await publisher("npm")
    const saved = manifest()
    await npm(saved)
    const recorded = await commands()
    expect(recorded).toEqual(npmCommands(saved).map((args) => args.slice(1)))
    expect(recorded.map((args) => path.basename(args[1]))).toEqual(
      ["sdk", "plugin", ...platforms, "cli"].map((name) => `${name}.tgz`),
    )
    expect(recorded.every((args) => args.includes("--ignore-scripts") && args.includes("latest"))).toBe(true)
  })

  test("stops npm publication on the first error", async () => {
    const commands = await publisher("npm")
    process.env.RELEASE_TEST_FAIL = "plugin.tgz"
    await expect(npm(manifest())).rejects.toThrow("publication conflict")
    expect((await commands()).map((args) => path.basename(args[1]))).toEqual(["sdk.tgz", "plugin.tgz"])
  })
})
