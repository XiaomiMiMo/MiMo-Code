#!/usr/bin/env bun
// Release from this repo alone. Bun auto-loads `.env`; this entry only maps
// those values onto the names the build/upload scripts read, then runs the
// standard version → build → publish → finalize path.
//
// `.env` / CI secrets:
//   GH_TOKEN or GITHUB_TOKEN     GitHub auth (gh CLI; GITHUB_TOKEN is the CI standard)
//   GH_REPO                      default XiaomiMiMo/MiMo-Code
//   MIMO_FDS_AK / MIMO_FDS_SK    FDS upload credentials (same names build/fds-upload read)
//   MIMOCODE_VERSION             optional; must match packages/opencode/package.json
//   MIMOCODE_SKIP_VERSION_CHECK  set to 1 to force a mismatched version
//
// Usage: bun run script/release.ts [version]

import { $ } from "bun"
import path from "path"

const rootPkgDir = path.resolve(import.meta.dir, "..")

// Bun already loaded `.env`. Standard CI names map onto the names the tools
// read; our own credentials keep their canonical long names (no short aliases).
process.env.GH_TOKEN ||= process.env.GITHUB_TOKEN
process.env.GH_REPO ||= "XiaomiMiMo/MiMo-Code"
process.env.MIMOCODE_RELEASE ||= "1"

const targetVersion = process.argv[2] || process.env.MIMOCODE_VERSION
if (targetVersion) process.env.MIMOCODE_VERSION = targetVersion

if (!process.env.GH_TOKEN) throw new Error("Missing required env: GH_TOKEN or GITHUB_TOKEN")

const pkgVersion = await Bun.file(path.join(rootPkgDir, "packages/opencode/package.json"))
  .json()
  .then((data: { version: string }) => data.version)
if (targetVersion && targetVersion !== pkgVersion) {
  if (process.env.MIMOCODE_SKIP_VERSION_CHECK !== "1") {
    throw new Error(
      `version mismatch — releasing v${targetVersion} but packages/opencode/package.json is v${pkgVersion}.\n` +
        `Land the version bump first, or set MIMOCODE_SKIP_VERSION_CHECK=1 to force.`,
    )
  }
  console.warn(`MIMOCODE_SKIP_VERSION_CHECK=1 — continuing despite v${targetVersion} != package v${pkgVersion}`)
}

const GH_REPO = process.env.GH_REPO

console.log("=== version ===\n")
await $`./script/version.ts`

const { Script } = await import("./meta.ts")
console.log(`\nReleasing v${Script.version} (channel: ${Script.channel})\n`)

console.log("=== build ===\n")
await $`./packages/opencode/script/build.ts`

console.log("\n=== publish npm ===\n")
await $`./script/publish.ts`

if (Script.release) {
  console.log("\n=== finalize release ===\n")
  await $`gh release edit v${Script.version} --draft=false --repo ${GH_REPO}`
  console.log(`https://github.com/${GH_REPO}/releases/tag/v${Script.version}`)
}

console.log("\n=== done ===")
