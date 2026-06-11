#!/usr/bin/env bun

import { $ } from "bun"

const required = (name: string) => {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env: ${name}`)
  return val
}

const GH_REPO = required("GH_REPO")
const NPM_TOKEN = required("NPM_TOKEN")

process.env.NODE_AUTH_TOKEN = NPM_TOKEN
process.env.GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN

if (!process.env.GH_TOKEN) throw new Error("Missing required env: GH_TOKEN or GITHUB_TOKEN")

console.log("=== version ===\n")
await $`./script/version.ts`

const { Script } = await import("@mimo-ai/script")
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
