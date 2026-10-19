#!/usr/bin/env bun
// Release stages run by .github/workflows/release.yml for a pushed vX.Y.Z tag.
// Usage: MIMOCODE_VERSION=vX.Y.Z bun script/release.ts <verify|build|preflight|github|fds|npm libs|npm cli>
//        bun script/release.ts trust   (one-time npm trusted publisher setup)
//
// build writes dist/release/{archives,npm}; the publishing stages only read it.
// preflight must run before any publish stage so bad FDS creds or missing
// tarballs cannot leave npm/GitHub half-shipped.
// Publishing stages are idempotent so "Re-run failed jobs" resumes a release.

import { $ } from "bun"
import path from "path"
import { cp, mkdir, rm } from "node:fs/promises"
import { uploadFile } from "./fds-upload"

const root = path.resolve(import.meta.dir, "..")
const out = path.join(root, "dist/release")

export const platforms = [
  "linux-arm64",
  "linux-x64",
  "linux-x64-baseline",
  "linux-arm64-musl",
  "linux-x64-musl",
  "linux-x64-baseline-musl",
  "darwin-arm64",
  "darwin-x64",
  "darwin-x64-baseline",
  "windows-arm64",
  "windows-x64",
  "windows-x64-baseline",
].map((name) => `mimocode-${name}`)

const archive = (name: string) => `${name}.${name.includes("linux") ? "tar.gz" : "zip"}`
const tarball = (name: string, version: string) => `${name.slice(1).replace("/", "-")}-${version}.tgz`

const npmGroups = {
  libs: ["@mimo-ai/sdk", "@mimo-ai/plugin"],
  // Platform binaries ship on FDS/GitHub only. npm stays limited support:
  // just the launcher wrapper (plus the two libraries above).
  cli: ["@mimo-ai/cli"],
}

export const npmPackages = [...npmGroups.libs, ...npmGroups.cli]

export function stableVersion(value: string | undefined) {
  if (!value || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Expected MIMOCODE_VERSION=MAJOR.MINOR.PATCH, received ${value ?? "nothing"}`)
  }
  return value
}

export async function verify(version: string, cwd = root) {
  const tag = `v${version}`
  const head = (await $`git rev-parse HEAD`.cwd(cwd).quiet().text()).trim()
  const target = await $`git rev-parse --verify ${`refs/tags/${tag}^{commit}`}`.cwd(cwd).nothrow().quiet()
  if (target.exitCode !== 0 || target.text().trim() !== head) throw new Error(`HEAD must be the commit tagged ${tag}`)
  if ((await $`git merge-base --is-ancestor ${head} origin/main`.cwd(cwd).nothrow().quiet()).exitCode !== 0) {
    throw new Error(`${tag} must point to a commit on origin/main`)
  }
  const mismatched = (
    await Promise.all(
      ["cli", "sdk", "plugin", "shared"].map(async (name) => ({
        name,
        version: (await Bun.file(path.join(cwd, "packages", name, "package.json")).json()).version,
      })),
    )
  ).filter((pkg) => pkg.version !== version)
  if (mismatched.length) {
    throw new Error(
      `Package versions must equal ${version}: ${mismatched.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`,
    )
  }
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets)
  return []
}

export function distExports(value: unknown): unknown {
  if (typeof value === "string") {
    const file = value.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "")
    return { types: `${file}.d.ts`, import: `${file}.js` }
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, distExports(item)]))
  }
  return value
}

async function pack(dir: string, name: string, version: string, dest: string) {
  await $`${process.execPath} pm pack --ignore-scripts --destination ${dest}`.cwd(dir).quiet()
  const file = path.join(dest, tarball(name, version))
  const pkg = JSON.parse(await $`tar -xOzf ${file} package/package.json`.quiet().text())
  if (pkg.name !== name || pkg.version !== version) throw new Error(`Unexpected tarball metadata in ${file}`)
  if (
    /"(workspace|catalog):/.test(JSON.stringify([pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies]))
  ) {
    throw new Error(`Unresolved workspace/catalog dependency in ${file}`)
  }
  const entries = new Set((await $`tar -tzf ${file}`.quiet().text()).split("\n"))
  const missing = [...exportTargets(pkg.exports), ...exportTargets(pkg.bin)].filter(
    (target) => !entries.has(`package/${target.replace(/^\.\//, "")}`),
  )
  if (missing.length) throw new Error(`${file} is missing ${missing.join(", ")}`)
  return file
}

// Compile committed SDK/plugin sources; the SDK generator is a manual step and
// never runs during a release.
export async function packLibrary(name: "sdk" | "plugin", version: string, dest: string) {
  const dir = path.join(root, "packages", name)
  const manifest = path.join(dir, "package.json")
  const original = await Bun.file(manifest).text()
  const pkg = JSON.parse(original)
  await rm(path.join(dir, "dist"), { recursive: true, force: true })
  await $`${process.execPath} ${path.join(root, "node_modules/typescript/bin/tsc")} --composite false --incremental false`.cwd(
    dir,
  )
  await Bun.write(manifest, JSON.stringify({ ...pkg, exports: distExports(pkg.exports) }, null, 2) + "\n")
  await cp(path.join(root, "README_npm.md"), path.join(dir, "README.md"))
  await cp(path.join(root, "LICENSE"), path.join(dir, "LICENSE"))
  try {
    return await pack(dir, pkg.name, version, dest)
  } finally {
    await Bun.write(manifest, original)
    await rm(path.join(dir, "README.md"), { force: true })
    await rm(path.join(dir, "LICENSE"), { force: true })
  }
}

async function packCli(version: string, dest: string) {
  const cli = path.join(root, "packages/cli")
  const stage = path.join(out, "stage/cli")
  await mkdir(stage, { recursive: true })
  await cp(path.join(cli, "mimo.js"), path.join(stage, "mimo.js"))
  await cp(path.join(cli, "launcher.js"), path.join(stage, "launcher.js"))
  await cp(path.join(cli, "postinstall.mjs"), path.join(stage, "postinstall.mjs"))
  await cp(path.join(root, "README_npm.md"), path.join(stage, "README.md"))
  await cp(path.join(root, "LICENSE"), path.join(stage, "LICENSE"))
  await Bun.write(
    path.join(stage, "package.json"),
    JSON.stringify(
      {
        name: "@mimo-ai/cli",
        version,
        type: "module",
        // Extensionless-free ESM entry (mimo.js) still wants a modern Node for fetch/AbortSignal.timeout.
        engines: { node: ">=20.10.0" },
        description: "MiMo Code: Where Models and Agents Co-Evolve",
        license: "MIT",
        author: "Xiaomi MiMo Team",
        homepage: "https://mimo.xiaomi.com/coder",
        repository: { type: "git", url: "git+https://github.com/XiaomiMiMo/MiMo-Code.git" },
        bugs: { url: "https://github.com/XiaomiMiMo/MiMo-Code/issues" },
        keywords: ["ai", "cli", "code", "xiaomi", "mimo", "mimocode"],
        bin: { mimo: "./mimo.js" },
        scripts: { postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs" },
      },
      null,
      2,
    ) + "\n",
  )
  await pack(stage, "@mimo-ai/cli", version, dest)
  await rm(path.join(out, "stage"), { recursive: true, force: true })
}

async function build(version: string) {
  await verify(version)
  await rm(out, { recursive: true, force: true })
  await mkdir(path.join(out, "archives"), { recursive: true })
  await mkdir(path.join(out, "npm"), { recursive: true })
  await $`${process.execPath} run script/build.ts --archive`
    .cwd(path.join(root, "packages/cli"))
    .env({ ...process.env, MIMOCODE_VERSION: version, MIMOCODE_CHANNEL: "latest" })
  for (const name of platforms) {
    await cp(path.join(root, "packages/cli/dist", archive(name)), path.join(out, "archives", archive(name)))
  }
  await packLibrary("sdk", version, path.join(out, "npm"))
  await packLibrary("plugin", version, path.join(out, "npm"))
  await packCli(version, path.join(out, "npm"))
  const dirty = (await $`git status --porcelain`.cwd(root).quiet().text()).trim()
  if (dirty) throw new Error(`Release build modified the checkout:\n${dirty}`)
  console.log(`Built ${platforms.length} archives and ${npmGroups.libs.length + npmGroups.cli.length} npm tarballs`)
}

async function github(version: string) {
  const tag = `v${version}`
  const files = platforms.map((name) => path.join(out, "archives", archive(name)))
  const existing = await $`gh release view ${tag} --json isDraft --jq .isDraft`.nothrow().quiet()
  if (existing.exitCode !== 0) {
    await $`gh release create ${tag} --verify-tag --title ${tag} --generate-notes ${files}`
    return
  }
  if (existing.text().trim() === "false") {
    console.log(`GitHub Release ${tag} is already published`)
    return
  }
  await $`gh release upload ${tag} ${files} --clobber`
  await $`gh release edit ${tag} --draft=false`
}

async function fds(version: string) {
  for (const name of platforms) {
    await uploadFile(path.join(out, "archives", archive(name)), `releases/v${version}/${archive(name)}`)
    console.log(`Uploaded to FDS: releases/v${version}/${archive(name)}`)
  }
  // The installer follows releases/latest, so move it only after every archive exists.
  await Bun.write(path.join(out, "latest.txt"), version)
  await uploadFile(path.join(out, "latest.txt"), "releases/latest", "text/plain")
  console.log(`Uploaded to FDS: releases/latest -> ${version}`)
}

// Fail if any npm tarball is missing or its embedded name/version drifted.
export async function assertTarballs(version: string, dir = path.join(out, "npm")) {
  const problems: string[] = []
  for (const name of npmPackages) {
    const file = path.join(dir, tarball(name, version))
    if (!(await Bun.file(file).exists())) {
      problems.push(`${name}: missing ${path.relative(root, file)}`)
      continue
    }
    const pkg = JSON.parse(await $`tar -xOzf ${file} package/package.json`.quiet().text())
    if (pkg.name !== name || pkg.version !== version) {
      problems.push(`${name}: tarball has ${pkg.name}@${pkg.version}, expected ${name}@${version}`)
    }
  }
  if (problems.length) throw new Error(`Release tarballs are not ready:\n${problems.join("\n")}`)
}

export function assertFdsCredentials(env: Record<string, string | undefined> = process.env) {
  if (!env.MIMO_FDS_AK || !env.MIMO_FDS_SK) throw new Error("MIMO_FDS_AK / MIMO_FDS_SK must be set before publish")
}

// Gate before any publish stage: prove the artifact is complete and FDS accepts
// a signed write, so a bad release cannot half-ship npm and/or GitHub.
async function preflight(version: string) {
  await assertTarballs(version)
  assertFdsCredentials()
  await Bun.write(path.join(out, "preflight.txt"), version)
  await uploadFile(path.join(out, "preflight.txt"), `releases/v${version}/.preflight-ok`)
  console.log(`Preflight OK: ${npmPackages.length} tarballs ready; FDS accepted canary for v${version}`)
}

async function npm(version: string, group: keyof typeof npmGroups) {
  // Trusted publishing (OIDC) needs npm >= 11.5.1.
  const npmVersion = (await $`npm --version`.quiet().text()).trim()
  if (Bun.semver.order(npmVersion, "11.5.1") < 0) throw new Error(`npm ${npmVersion} cannot use trusted publishing`)
  for (const name of npmGroups[group]) {
    const view = await $`npm view ${`${name}@${version}`} version`.nothrow().quiet()
    if (view.text().trim() === version) {
      console.log(`${name}@${version} is already published`)
      continue
    }
    await $`npm publish ${path.join(out, "npm", tarball(name, version))} --access public --tag latest`
  }
}

// One-time maintainer setup, run locally after `npm login` (2FA session, not a token):
// registers release.yml as the trusted publisher of every package this script publishes.
async function trust() {
  const npm = ["npx", "-y", "npm@^11.19.0"]
  for (const name of [...npmGroups.libs, ...npmGroups.cli]) {
    const existing = await $`${npm} trust list ${name}`.nothrow().quiet()
    if (existing.exitCode === 0 && existing.text().includes("release.yml")) {
      console.log(`${name}: trusted publisher already configured`)
      continue
    }
    const child = Bun.spawn(
      [
        ...npm,
        "trust",
        "github",
        name,
        "--file",
        "release.yml",
        "--repo",
        "XiaomiMiMo/MiMo-Code",
        "--env",
        "release",
        "--allow-publish",
        "--yes",
      ],
      { stdio: ["inherit", "inherit", "inherit"] },
    )
    if ((await child.exited) !== 0) throw new Error(`Failed to configure the trusted publisher for ${name}`)
  }
}

if (import.meta.main) {
  const version = () => stableVersion(process.env.MIMOCODE_VERSION?.replace(/^v/, ""))
  const stages: Record<string, () => Promise<void>> = {
    verify: () => verify(version()),
    build: () => build(version()),
    preflight: () => preflight(version()),
    github: () => github(version()),
    fds: () => fds(version()),
    "npm libs": () => npm(version(), "libs"),
    "npm cli": () => npm(version(), "cli"),
    trust,
  }
  const stage = stages[process.argv.slice(2).join(" ")]
  if (!stage) throw new Error("Usage: bun script/release.ts <verify|build|preflight|github|fds|npm libs|npm cli|trust>")
  await stage()
}
