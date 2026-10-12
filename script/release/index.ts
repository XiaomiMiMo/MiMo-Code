#!/usr/bin/env bun
// Stable releases consume an existing main-branch tag and committed versions.
// Usage: bun run release <version>, or MIMOCODE_VERSION=<version>
// MIMOCODE_CHANNEL=latest bun script/release/index.ts --stage build|github|fds|npm.
// --dry-run performs read-only preflight and local artifact validation.
import path from "node:path"
import { parseArgs } from "node:util"
import { build } from "./build"
import { directory, preflight, required } from "./context"
import { fds } from "./fds"
import { github } from "./github"
import { validateManifest, verifyFiles } from "./manifest"
import { npm } from "./npm"

export async function release(options: { stage?: string; version?: string; dryRun?: boolean } = {}) {
  const stage = options.stage
  if (stage && !["build", "github", "fds", "npm"].includes(stage)) throw new Error(`Unknown release stage: ${stage}`)
  if (options.version) process.env.MIMOCODE_VERSION = options.version
  process.env.MIMOCODE_CHANNEL ||= "latest"
  const expected = await preflight(required("MIMOCODE_VERSION"))
  if (options.dryRun) {
    if (stage && stage !== "build") {
      await verifyFiles(
        directory,
        validateManifest(
          await Bun.file(path.join(directory, "manifest.json")).json(),
          expected.version,
          expected.commit,
        ),
      )
    }
    console.log(`Read-only validation passed for ${expected.tag} (${expected.commit})`)
    return
  }
  if (!stage) {
    required("GH_REPO")
    required("GH_TOKEN")
    required("MIMO_FDS_AK")
    required("MIMO_FDS_SK")
    required("NODE_AUTH_TOKEN")
  }
  if (!stage || stage === "build") {
    console.log("=== Release stage: build ===")
    await build(expected)
  }
  if (stage === "build") return
  const manifest = validateManifest(
    await Bun.file(path.join(directory, "manifest.json")).json(),
    expected.version,
    expected.commit,
  )
  await verifyFiles(directory, manifest)
  if (!stage || stage === "github") {
    console.log("=== Release stage: github ===")
    await github(expected, manifest)
  }
  if (!stage || stage === "fds") {
    console.log("=== Release stage: fds ===")
    await fds(expected, manifest)
  }
  if (!stage || stage === "npm") {
    console.log("=== Release stage: npm ===")
    await npm(manifest)
  }
}

if (import.meta.main) {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: { stage: { type: "string" }, "dry-run": { type: "boolean" } },
    allowPositionals: true,
  })
  if (args.positionals.length > 1) throw new Error("Expected at most one release version")
  await release({ stage: args.values.stage, dryRun: args.values["dry-run"], version: args.positionals[0] })
}
