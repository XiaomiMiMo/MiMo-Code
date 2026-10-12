#!/usr/bin/env bun
// Publish prepacked artifacts after GitHub and FDS; never generate the SDK.
import { release } from "./release"

await release({ stage: "npm" })
