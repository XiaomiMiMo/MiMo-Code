#!/usr/bin/env bun
// Version preparation and tag creation happen manually before the release.
throw new Error(
  "Draft-only release creation is disabled. Use bun script/release.ts --stage github with the verified release artifacts.",
)
