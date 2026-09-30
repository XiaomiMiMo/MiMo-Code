#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/script/build.ts`

// TODO: Temporarily disabled — we currently rely on AI-assisted diff editing
// rather than running the formatter. Re-enable after the next repo cleanup.
// await $`./script/format.ts`
