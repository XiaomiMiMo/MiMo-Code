#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { createClient } from "@hey-api/openapi-ts"

// Schema generation boots the CLI and its migrations. Isolate all runtime data.
const runtime = await mkdtemp(path.join(tmpdir(), "mimocode-sdk-"))
try {
  await $`bun dev generate > ${dir}/openapi.json`
    .cwd(path.resolve(dir, "../../opencode"))
    .env({
      ...process.env,
      MIMOCODE_DB: ":memory:",
      HOME: runtime,
      USERPROFILE: runtime,
      XDG_DATA_HOME: path.join(runtime, "data"),
      XDG_CONFIG_HOME: path.join(runtime, "config"),
      XDG_CACHE_HOME: path.join(runtime, "cache"),
      XDG_STATE_HOME: path.join(runtime, "state"),
    })
} finally {
  await rm(runtime, { recursive: true, force: true })
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
