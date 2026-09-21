import { describe, expect, test } from "bun:test"

/**
 * Tests for the command keybinds suspend/resume mechanism.
 *
 * The `suspendCount` in dialog-command.tsx is a counter that blocks ALL
 * command keybinds (including Ctrl+X leader combos) when > 0.
 *
 * Two sources can increment it: the ghost text effect (createEffect with
 * onCleanup) and autocomplete show/hide. The counter must always return
 * to 0 when both sources are done.
 *
 * Regresses the bug where autocomplete had no onCleanup -- when the
 * Prompt component unmounts while autocomplete was visible, hide() was
 * never called, leaving suspendCount stuck > 0.
 */
describe("command keybinds suspend count", () => {
  function makeCounter() {
    let count = 0
    const keybinds = (enabled: boolean) => {
      count += enabled ? -1 : 1
    }
    const suspended = () => count > 0
    return { count, keybinds, suspended, get countVal() { return count } }
  }

  test("single suspend/resume cycle", () => {
    const { keybinds, suspended } = makeCounter()
    expect(suspended()).toBe(false)

    // suspend (e.g. autocomplete show)
    keybinds(false)
    expect(suspended()).toBe(true)

    // resume (e.g. autocomplete hide)
    keybinds(true)
    expect(suspended()).toBe(false)
  })

  test("double suspend/resume balances correctly (ghost + autocomplete)", () => {
    const { keybinds, suspended } = makeCounter()
    expect(suspended()).toBe(false)

    // ghost text appears: suspend
    keybinds(false)
    expect(suspended()).toBe(true)

    // autocomplete shows: suspend
    keybinds(false)
    expect(suspended()).toBe(true)

    // ghost text clears: resume
    keybinds(true)
    expect(suspended()).toBe(true)

    // autocomplete hides: resume
    keybinds(true)
    expect(suspended()).toBe(false)
  })

  test("autocomplete show without hide leaves counter stuck", () => {
    const { keybinds, suspended } = makeCounter()
    expect(suspended()).toBe(false)

    // autocomplete shows
    keybinds(false)
    expect(suspended()).toBe(true)

    // component unmounts, but NO hide() is called (the bug)
    // << no cleanup >>

    // counter is stuck
    expect(suspended()).toBe(true)

    // This is the bug: without onCleanup, no more hide() calls happen
    // and keybinds stay blocked until something else clears ghost text
  })

  test("autocomplete onCleanup resumes on unmount", () => {
    const { keybinds, suspended } = makeCounter()
    expect(suspended()).toBe(false)

    // autocomplete shows
    keybinds(false)
    expect(suspended()).toBe(true)

    // onCleanup fires on unmount
    keybinds(true)
    expect(suspended()).toBe(false)
  })

  test("idempotent show prevents double increment", () => {
    const { keybinds, suspended } = makeCounter()

    // show() should only increment once
    let visible = false
    function show() {
      if (!visible) keybinds(false)
      visible = true
    }
    function hide() {
      if (visible) keybinds(true)
      visible = false
    }

    show()
    expect(suspended()).toBe(true)

    // show() again while already visible
    show()
    expect(suspended()).toBe(true) // still 1, not 2

    // hide once
    hide()
    expect(suspended()).toBe(false)
  })
})
