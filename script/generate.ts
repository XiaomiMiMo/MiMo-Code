#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/opencode")

// TODO: Temporarily disabled — we currently rely on AI-assisted diff editing
// rather than running the formatter. Re-enable after the next repo cleanup.
// await $`./script/format.ts`
