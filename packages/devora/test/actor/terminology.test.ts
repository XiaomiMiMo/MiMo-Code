import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dir, "../..")

const ACTIVE_ACTOR_FILES = [
  "src/actor/registry.ts",
  "src/tool/actor.ts",
  "src/tool/actor.txt",
  "test/actor/registry.test.ts",
  "test/tool/actor.test.ts",
  "test/tool/actor-status.test.ts",
  "test/tool/actor-wait.test.ts",
  "test/tool/actor-cancel.test.ts",
]

// Only check for terms that are clearly legacy and should have been renamed.
// "subagent" is retained as a legitimate schema value (mode: "subagent") and
// API parameter name (subagent_type) — renaming those would be a breaking change.
const LEGACY_ACTOR_TERMS = [
  /sub-agent/g,
  /Background task/g,
  /\btaskRegistry\b/g,
  /Active Background Tasks/g,
  /\bTask status\b/g,
  /\bTask wait\b/g,
]

describe("actor terminology", () => {
  for (const file of ACTIVE_ACTOR_FILES) {
    test(`${file} uses actor terminology for actor execution`, () => {
      const text = readFileSync(path.join(ROOT, file), "utf8")
      for (const pattern of LEGACY_ACTOR_TERMS) {
        expect(text.match(pattern) ?? [], `${file} contains ${pattern}`).toHaveLength(0)
      }
    })
  }
})
