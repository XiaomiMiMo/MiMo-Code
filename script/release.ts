#!/usr/bin/env bun
// Release from this repo alone (no sibling checkouts). Bun auto-loads `.env`;
// this entry maps those values onto the names downstream scripts read, then
// runs version → build → publish → finalize.
//
// Three publish channels (all driven by this entry):
//   1. GitHub Release  — draft in version.ts, binaries uploaded by
//      packages/cli/script/build.ts, undrafted at the end of this script.
//   2. Xiaomi FDS      — same build step uploads archives + releases/latest
//      via script/fds-upload.ts when MIMO_FDS_AK/SK are present.
//   3. npm             — script/publish.ts ships @mimo-ai/cli + platform
//      binaries + @mimo-ai/sdk + @mimo-ai/plugin.
//
// `.env` / CI secrets:
//   GH_TOKEN or GITHUB_TOKEN     GitHub auth (gh CLI; GITHUB_TOKEN is the CI standard)
//   GH_REPO                      default XiaomiMiMo/MiMo-Code
//   MIMO_FDS_AK / MIMO_FDS_SK    FDS upload credentials (same names build/fds-upload read)
//   MIMOCODE_VERSION             optional; must match packages/cli/package.json
//   MIMOCODE_SKIP_VERSION_CHECK  set to 1 to force a mismatched version
//
// Usage: bun run release [version]
//   1. Land the version bump in packages/cli/package.json first.
//   2. Put secrets in .env (or export / CI secrets).
//   3. bun run release 0.2.0

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

const pkgVersion = await Bun.file(path.join(rootPkgDir, "packages/cli/package.json"))
  .json()
  .then((data: { version: string }) => data.version)
if (targetVersion && targetVersion !== pkgVersion) {
  if (process.env.MIMOCODE_SKIP_VERSION_CHECK !== "1") {
    throw new Error(
      `version mismatch — releasing v${targetVersion} but packages/cli/package.json is v${pkgVersion}.\n` +
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
await $`./packages/cli/script/build.ts`

console.log("\n=== publish npm ===\n")
await $`./script/publish.ts`

if (Script.release) {
  console.log("\n=== finalize release ===\n")
  await $`gh release edit v${Script.version} --draft=false --repo ${GH_REPO}`
  console.log(`https://github.com/${GH_REPO}/releases/tag/v${Script.version}`)
}

console.log("\n=== done ===")
