import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"

describe("ActorCompleted retirement guard (Plan 3 / Task 5)", () => {
  test("actor/completion.ts is absent", () => {
    const completionPath = path.join(__dirname, "../../src/actor/completion.ts")
    expect(fs.existsSync(completionPath)).toBe(false)
  })

  test("actor/events.ts does not export ActorCompleted", () => {
    const eventsPath = path.join(__dirname, "../../src/actor/events.ts")
    const contents = fs.readFileSync(eventsPath, "utf-8")
    expect(contents).not.toContain("ActorCompleted")
  })

  test("actor/index.ts does not re-export ActorCompletion", () => {
    const indexPath = path.join(__dirname, "../../src/actor/index.ts")
    const contents = fs.readFileSync(indexPath, "utf-8")
    expect(contents).not.toContain("ActorCompletion")
  })

  test("no source file references ActorCompleted or ActorCompletion", () => {
    const srcRoot = path.join(__dirname, "../../src")
    const violations: string[] = []
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith(".ts")) {
          const txt = fs.readFileSync(full, "utf-8")
          if (/\bActorCompleted\b|\bActorCompletion\b/.test(txt)) {
            violations.push(full)
          }
        }
      }
    }
    walk(srcRoot)
    expect(violations).toEqual([])
  })
})
