import { describe, expect, test } from "bun:test"
import PROMPT_ORCHESTRATOR from "../../src/session/prompt/orchestrator.txt"

// ============================================================
// Orchestrator route-first + digital-twin behavior tests — PR #1741
//
// These test the PROMPT CONTENT (what guidance the orchestrator.txt encodes).
// Roster injection/filtering is tested via the existing llm-system-prompt.test.ts
// which exercises the full buildSystemArray path. These tests verify the
// behavioral guidance is present and correct — the mechanism that determines
// the orchestrator's behavior given the roster.
//
// For behaviors only testable via e2e (actual create-vs-route decision, the
// AI's judgment given the roster + prompt), the mechanism tests (roster
// correctly injected + filtered, prompt correctly guides) ARE the regression
// protection. The actual LLM decision is inherently non-deterministic and
// covered by manual TUI verification.
// ============================================================

describe("orchestrator prompt — digital-twin identity", () => {
  test("declares itself as user's digital twin", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/DIGITAL TWIN/i)
  })

  test("ACT, DON'T ASK principle present", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/ACT, DON.*T ASK/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/Default = do it, then report/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/Do not ask.*shall I do/)
  })

  test("PROACTIVELY COMPLETE THE INTENT principle present", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/PROACTIVELY COMPLETE THE INTENT/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/FULL intent/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/proactively/)
  })

  test("REPORT-not-ask phrasing guidance present", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/REPORT.*don.*t ask/)
    // Has good/bad examples
    expect(PROMPT_ORCHESTRATOR).toMatch(/BAD:.*Shall I/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/GOOD:.*proactively/)
  })

  test("route-analysis, don't self-analyze principle present", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Route analysis.*don.*t self-analyze/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/DISPATCH a session to analyze/)
  })
})

describe("orchestrator prompt — four core duties", () => {
  test("declares four core duties", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/four core duties/)
  })

  test("duty 1: Dispatch — route work", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Dispatch.*route work/i)
    expect(PROMPT_ORCHESTRATOR).toContain("FLEET ROSTER")
    expect(PROMPT_ORCHESTRATOR).toContain("session send")
    expect(PROMPT_ORCHESTRATOR).toContain("session create")
  })

  test("duty 2: Act for user — answer, approve, decide", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Act for the user.*answer.*approve.*decide/i)
    expect(PROMPT_ORCHESTRATOR).toContain("session approve")
    expect(PROMPT_ORCHESTRATOR).toContain("grant-approval")
  })

  test("duty 3: Proactively complete the intent", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Proactively complete the intent/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/FULL intent/)
  })

  test("duty 4: Audit quality — verify before declaring done", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Audit quality.*verify before declaring done/)
    expect(PROMPT_ORCHESTRATOR).toContain("session status")
    expect(PROMPT_ORCHESTRATOR).toContain("session ask")
  })
})

describe("orchestrator prompt — route-first dispatch", () => {
  test("instructs to route to existing session before creating", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/DO NOT create.*existing/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/existing one can handle/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/existing child first.*create only as fallback/i)
  })

  test("mentions session send as primary dispatch verb", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/primary dispatch verb/)
  })

  test("references the fleet roster functionally, never by its internal tag", () => {
    expect(PROMPT_ORCHESTRATOR).toContain("fleet roster")
    // TEXT PIN, not a behavioural assertion: it pins the wording of a prose file.
    // The mechanism that actually stops the tag being echoed is that the tag no
    // longer exists in the assembled request at all — asserted on the WIRE in
    // `orchestrator-active-sessions.test.ts` ("not.toContain(\"<active-sessions>\")").
    // This assertion exists so the prompt cannot re-teach the tag as vocabulary.
    expect(PROMPT_ORCHESTRATOR).not.toContain("<active-sessions>")
    // Assert the LITERAL documented format, not a loose `.*agent.*` regex: the
    // surrounding prose also contains the word "AGENT", so a regex matches even
    // when the format line still says `mode`. Field 3 must be the child's agent,
    // matching what session/llm.ts actually emits.
    expect(PROMPT_ORCHESTRATOR).toContain("compact format: id | title | agent | status")
    expect(PROMPT_ORCHESTRATOR).not.toContain("id | title | mode | status")
  })
})

describe("orchestrator prompt — session lifecycle safety", () => {
  test("finished sessions stay resumable, cancel is destroy-only", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Finished sessions stay resumable/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/DESTROY/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/Completed.*never means.*cancel/i)
  })

  test("session send resumes a session from persisted history — not just relay", () => {
    // send is documented as a resume verb, not only new-task relay
    expect(PROMPT_ORCHESTRATOR).toMatch(/send.*RESUMES/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/persisted history/i)
    // resume works regardless of status; status does not gate it
    expect(PROMPT_ORCHESTRATOR).toMatch(/regardless of status/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/does NOT gate resume/i)
    // prefer resume-via-send over recreating a child from memory
    expect(PROMPT_ORCHESTRATOR).toMatch(/resume.*recover an interrupted\/crashed child/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/rather than.*session create/i)
  })

  test("don't poll, wait event-driven", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/don.*t poll/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/event-driven/)
  })

  test("idle without notification — verify with git", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Idle without notification/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/verify with git/)
  })
})

describe("orchestrator prompt — child git-ownership (#6 / #1822)", () => {
  test("child operates only on its own branch — never rebases/merges/checkouts another", () => {
    // A child MUST NOT rebase/merge/checkout any branch it does not own, because
    // all worktrees share one .git/ ref store and a cross-branch op can move the
    // main checkout's HEAD.
    expect(PROMPT_ORCHESTRATOR).toMatch(/never rebase.*own|only.*own branch|MUST NEVER rebase/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/share.*one .*\.git\/.* ref store|shared refs|shared.*ref store/i)
  })

  test("all cross-branch integration is the orchestrator's job, not the child's", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/integration.*ORCHESTRATOR|ORCHESTRATOR.*job|never delegate it to a child/i)
    // Child's only safe git verbs are commit + push on its own branch.
    expect(PROMPT_ORCHESTRATOR).toMatch(/git commit.*git push.*own|commit.*push.*ITS OWN/i)
  })
})

describe("orchestrator prompt — topic recognition + reuse (#8)", () => {
  test("recognizes the topic of incoming work and reuses the standing session for it", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/recognize.*topic|identify the theme\/topic/i)
    expect(PROMPT_ORCHESTRATOR).toMatch(/reuse.*standing.*session/i)
  })

  test("uses --topic find-or-reuse rather than always creating a new child", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/--topic.*reuse|reuse.*--topic|--topic <label>.*find-or-reuse|find-or-reuse.*standing/i)
    // Explicitly ties topic recognition to reuse-by-topic, create only as fallback.
    expect(PROMPT_ORCHESTRATOR).toMatch(/recognize topic → reuse the standing session by topic|reuse the standing session by topic/i)
  })
})

describe("orchestrator prompt — proactively drive to terminal (#9)", () => {
  test("drives every non-human-review task to its terminal/done state", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/drive.*to.*(terminal|done|completion)|proactively drive/i)
    // Concrete operational examples: rerun flaky CI, fix builds, push PR to mergeable.
    expect(PROMPT_ORCHESTRATOR).toMatch(/rerun.*flaky|flaky.*rerun|rerun the failing shard/i)
  })

  test("human review is the ONLY thing it waits for", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/human review is the ONLY|only.*require.*human review.*wait|Only.*human-review tasks WAIT/i)
    // Distinguishes the wait-set (irreversible / merge / credential / ambiguous).
    expect(PROMPT_ORCHESTRATOR).toMatch(/irreversible|credential rotation|ambiguous product/i)
  })
})

describe("orchestrator prompt — safety invariants", () => {
  test("never blocks on real work", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/MUST NEVER block/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/actor run.*actor spawn/i)
  })

  test("captures requirements before acting", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Capture requirements before acting/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/reflex/)
  })

  test("delegates slow analysis", () => {
    expect(PROMPT_ORCHESTRATOR).toMatch(/Delegate slow ANALYSIS/)
    expect(PROMPT_ORCHESTRATOR).toMatch(/never run it inline/)
  })
})
