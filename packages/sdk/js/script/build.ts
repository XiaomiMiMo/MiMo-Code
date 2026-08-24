#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

await $`bun dev generate > ${dir}/openapi.json`.cwd(path.resolve(dir, "../../opencode"))

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

const titleSdkPath = path.join(dir, "src/v2/gen/sdk.gen.ts")
const titleSdk = await Bun.file(titleSdkPath).text()
const titleStart = titleSdk.indexOf("export class Title")
const titleEnd = titleSdk.indexOf("export class Experimental", titleStart)
const titleBlock = titleStart >= 0 && titleEnd > titleStart ? titleSdk.slice(titleStart, titleEnd) : ""
const requiredTitleBlock = titleBlock
  .replace("parameters?: {", "parameters: {")
  .replace("text?: string;", "text: string;")
const requiredTitleSdk =
  titleBlock && requiredTitleBlock !== titleBlock
    ? titleSdk.slice(0, titleStart) + requiredTitleBlock + titleSdk.slice(titleEnd)
    : titleSdk
if (requiredTitleSdk === titleSdk) throw new Error("failed to require title text in generated SDK")
await Bun.write(titleSdkPath, requiredTitleSdk)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
