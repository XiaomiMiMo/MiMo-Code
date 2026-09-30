#!/usr/bin/env bun
// Channel 3/3 (npm): stamp Script.version across package.json files, then
// publish @mimo-ai/cli + platform binaries, @mimo-ai/sdk, and @mimo-ai/plugin.
// Called by script/release.ts after the build step.
//
// Env: npm auth (npm login / NPM_TOKEN), version via script/meta.ts.

import { Script } from "./meta.ts"
import { $ } from "bun"
import { fileURLToPath } from "url"

console.log("=== publishing ===\n")

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

for (const file of pkgjsons) {
  let pkg = await Bun.file(file).text()
  pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${Script.version}"`)
  console.log("updated:", file)
  await Bun.file(file).write(pkg)
}

await $`bun install`
await $`./packages/sdk/script/build.ts`

console.log("\n=== cli ===\n")
await $`bun ./packages/cli/script/publish.ts`

console.log("\n=== sdk ===\n")
await $`bun ./packages/sdk/script/publish.ts`

console.log("\n=== plugin ===\n")
await $`bun ./packages/plugin/script/publish.ts`
