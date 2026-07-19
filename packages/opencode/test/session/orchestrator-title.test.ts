import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { ORCHESTRATOR_TITLE, stableRootTitle } from "../../src/session/prompt"

// An Orchestrator session is PERSISTENT: it coordinates many tasks over its
// lifetime, so its title must be stable and task-independent. The per-first-
// message auto-title generator (SessionPrompt.ensureTitle) must NOT rename it.
// `stableRootTitle` is the pure decision the generator consults before doing
// any LLM work: a non-undefined result means "keep this fixed title and SKIP
// generation"; undefined means "normal per-message titling applies".
describe("orchestrator stable title", () => {
  test("orchestrator ROOT session gets the fixed, task-independent title", () => {
    expect(stableRootTitle({ agent: "orchestrator", parentID: undefined })).toBe(ORCHESTRATOR_TITLE)
    expect(ORCHESTRATOR_TITLE).toBe("Orchestrator")
  })

  test("the stable title is NOT a default title, so it survives later turns", () => {
    // ensureTitle bails early when the title is no longer a default one. The
    // stable orchestrator title must qualify as non-default so a subsequent
    // task/message never triggers regeneration and never overwrites it.
    expect(Session.isDefaultTitle(ORCHESTRATOR_TITLE)).toBe(false)
  })

  test("a normal (non-orchestrator) ROOT session is unaffected — normal titling applies", () => {
    // undefined => ensureTitle proceeds with its usual per-first-message
    // generation path, exactly as before this fix.
    expect(stableRootTitle({ agent: "main", parentID: undefined })).toBeUndefined()
    expect(stableRootTitle({ agent: "build", parentID: undefined })).toBeUndefined()
    expect(stableRootTitle({ agent: undefined, parentID: undefined })).toBeUndefined()
  })

  test("orchestrator CHILD sessions are NOT force-titled (only the root is persistent)", () => {
    // Child sessions already skip auto-titling via the parentID guard; the
    // stable-title path must likewise never fire for a child, even one whose
    // triggering agent is orchestrator.
    expect(stableRootTitle({ agent: "orchestrator", parentID: "ses_parent" })).toBeUndefined()
    expect(stableRootTitle({ agent: "main", parentID: "ses_parent" })).toBeUndefined()
  })
})
