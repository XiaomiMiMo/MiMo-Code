#!/usr/bin/env bun
// Package-scoped publishing cannot safely bypass the release manifest/order.
throw new Error(
  "Package-only publishing is disabled. Use bun script/release.ts --stage npm with the verified release artifacts.",
)
