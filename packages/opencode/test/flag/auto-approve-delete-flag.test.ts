import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "../../src/flag/flag"

const original = process.env.MIMOCODE_AUTO_APPROVE_DELETE

function set(value?: string) {
  if (value === undefined) delete process.env.MIMOCODE_AUTO_APPROVE_DELETE
  else process.env.MIMOCODE_AUTO_APPROVE_DELETE = value
}

afterEach(() => set(original))

describe("MIMOCODE_AUTO_APPROVE_DELETE", () => {
  test("keeps the forced-ask confirmation by default", () => {
    set(undefined)
    expect(Flag.MIMOCODE_AUTO_APPROVE_DELETE).toBe(false)
  })

  // The value must be read on ACCESS, not at module-evaluation time. An embedder
  // that hosts the server in-process (the desktop app) toggles its approval mode
  // mid-session and has no process boundary at which to re-read env, so a frozen
  // literal would silently ignore every write after the first import. Flipping
  // within a single process is what distinguishes a getter from a literal —
  // spawning a fresh process per read would pass either way.
  test("tracks env writes made after the module was first imported", () => {
    set("true")
    expect(Flag.MIMOCODE_AUTO_APPROVE_DELETE).toBe(true)
    set("false")
    expect(Flag.MIMOCODE_AUTO_APPROVE_DELETE).toBe(false)
    set("true")
    expect(Flag.MIMOCODE_AUTO_APPROVE_DELETE).toBe(true)
  })

  test("treats 1/0 as the truthy/falsy aliases", () => {
    set("1")
    expect(Flag.MIMOCODE_AUTO_APPROVE_DELETE).toBe(true)
    set("0")
    expect(Flag.MIMOCODE_AUTO_APPROVE_DELETE).toBe(false)
  })
})
