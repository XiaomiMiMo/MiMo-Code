import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import type { ActorMatcher, ActorPreStopInput, ActorStopOutput, PluginInput } from "@mimo-ai/plugin"
import { CheckpointSplitoverPlugin } from "../../src/plugin/checkpoint-splitover"
import { matchesActor } from "../../src/plugin/matcher"
import * as CheckpointContext from "../../src/session/checkpoint-context"
import { checkpointPath, memoryPath, metaDir } from "../../src/session/checkpoint-paths"
import type { SessionID } from "../../src/session/schema"
import type { ProjectID } from "../../src/project/schema"

afterEach(() => {
  CheckpointContext._reset()
})

function tmpSessionID(): SessionID {
  return ("s_" + Math.random().toString(36).slice(2, 10)) as SessionID
}

function tmpProjectID(): ProjectID {
  return ("proj_test_" + Math.random().toString(36).slice(2, 10)) as ProjectID
}

function fakeInput(projectID: ProjectID): PluginInput {
  return {
    client: {},
    project: { id: projectID },
    directory: "",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost:4096"),
    $: undefined,
  } as unknown as PluginInput
}

function fakeStopInput(sessionID: SessionID): ActorPreStopInput {
  return {
    sessionID,
    actorID: "act_test",
    agentType: "checkpoint-writer",
    mode: "subagent",
    lifecycle: "ephemeral",
    task: "checkpoint",
    iteration: 0,
  }
}

async function setupSession(sessionID: SessionID, projectID: ProjectID): Promise<void> {
  await fs.mkdir(metaDir(sessionID), { recursive: true })
  await fs.mkdir(path.dirname(memoryPath(projectID)), { recursive: true })
}

const CLEAN_CHECKPOINT = `Topic: clean test checkpoint

### Execution context
(none)

### Live resources
(none)

### Session metadata
(none)

### Discovered
(none)

### Dead ends
(none)
`

const CLEAN_MEMORY = `## Rules
short rule
`

describe("CheckpointSplitoverPlugin", () => {
  test("clean checkpoint -> no reentry", async () => {
    const sessionID = tmpSessionID()
    const projectID = tmpProjectID()
    await setupSession(sessionID, projectID)
    await fs.writeFile(checkpointPath(sessionID), CLEAN_CHECKPOINT)
    await fs.writeFile(memoryPath(projectID), CLEAN_MEMORY)

    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["actor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object with matcher+run")

    const output: ActorStopOutput = {}
    await reg.run(fakeStopInput(sessionID), output)

    expect(output.continue).toBeUndefined()
    expect(output.reason).toBeUndefined()
  })

  test("extract-required → buildExtractionReflection in reason", async () => {
    const sessionID = tmpSessionID()
    const projectID = tmpProjectID()
    await setupSession(sessionID, projectID)
    // §1 Active intent budget is 500 tokens (~2000 chars). Blow past it.
    const oversized = "## §1 Active intent\n" + "x ".repeat(3000) + "\n"
    await fs.writeFile(checkpointPath(sessionID), oversized)
    await fs.writeFile(memoryPath(projectID), "## Rules\nok\n")

    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["actor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object")

    const output: ActorStopOutput = {}
    await reg.run(fakeStopInput(sessionID), output)

    expect(output.continue).toBe(true)
    expect(output.reason).toBeDefined()
    expect(output.reason!).toContain("EXTRACTION REQUIRED")
    expect(output.reason!).toContain("spillover")
  })

  test("regular error → buildReflectionMessage in reason", async () => {
    const sessionID = tmpSessionID()
    const projectID = tmpProjectID()
    await setupSession(sessionID, projectID)
    // checkpoint-validator emits severity:"error" with rule "topic-missing" when
    // the file is empty (checkpoint-retry.ts line 62-68). Create empty checkpoint.md.
    await fs.writeFile(checkpointPath(sessionID), "")
    await fs.writeFile(memoryPath(projectID), "## Rules\nshort\n")

    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["actor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object")

    const output: ActorStopOutput = {}
    await reg.run(fakeStopInput(sessionID), output)

    expect(output.continue).toBe(true)
    expect(output.reason).toBeDefined()
    expect(output.reason!).toContain("<system-reminder>")
    expect(output.reason!).toContain("CHECKPOINT_PATH = ")
    expect(output.reason!).toContain("MEMORY_PATH     = ")
  })

  test("extract-required wins over error", async () => {
    const sessionID = tmpSessionID()
    const projectID = tmpProjectID()
    await setupSession(sessionID, projectID)
    // §1 Active intent over budget AND checkpoint.md content present but
    // memory.md missing topics (would cause separate error). The hook should
    // pick the extract-required branch because that wins priority.
    const oversized = "## §1 Active intent\n" + "x ".repeat(3000) + "\n"
    await fs.writeFile(checkpointPath(sessionID), oversized)
    await fs.writeFile(memoryPath(projectID), "")  // empty memory file

    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["actor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object")

    const output: ActorStopOutput = {}
    await reg.run(fakeStopInput(sessionID), output)

    expect(output.continue).toBe(true)
    expect(output.reason!).toContain("EXTRACTION REQUIRED")
    expect(output.reason!).not.toContain("<system-reminder>")
  })

  test("hook never throws on pathological session IDs", async () => {
    // Different inputs route through different paths (graceful empty → error
    // branch, or genuine throw → catch). The universal invariant is: no
    // exception escapes the hook.
    const hooks = await CheckpointSplitoverPlugin(fakeInput(tmpProjectID()))
    const reg = hooks["actor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object")

    const cases: SessionID[] = [
      ("") as SessionID,
      ("s_/../../etc/passwd") as SessionID,
      ("s_nonexistent_session") as SessionID,
    ]
    for (const sid of cases) {
      const output: ActorStopOutput = {}
      await expect(reg.run(fakeStopInput(sid), output)).resolves.toBeUndefined()
    }
  })

  test("synchronous validator throw → caught by plugin (output untouched, no exception)", async () => {
    // NUL byte in session ID forces Bun.file() to throw synchronously inside
    // runValidatorsForCkpt — escaping the validator's own .catch(() => "")
    // handler. The plugin's outer try/catch must catch it.
    //
    // Load-bearing assertions:
    //   - resolves.toBeUndefined: catch path swallowed the exception.
    //   - output.continue undefined: distinguishes "catch fired" from
    //     "validator returned gracefully with topic-missing error" (which
    //     would set continue=true).
    const hooks = await CheckpointSplitoverPlugin(fakeInput(tmpProjectID()))
    const reg = hooks["actor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object")

    const output: ActorStopOutput = {}
    await expect(reg.run(fakeStopInput(("s_\x00bad") as SessionID), output)).resolves.toBeUndefined()
    expect(output.continue).toBeUndefined()
    expect(output.reason).toBeUndefined()
  })

  test("warn-only → no reentry", async () => {
    const sessionID = tmpSessionID()
    const projectID = tmpProjectID()
    await setupSession(sessionID, projectID)
    // validateSnapshot and validateLearning both emit severity:"warn" rule
    // "topic-too-long" when the Topic: line exceeds TOPIC_MAX_CHARS (80). Use
    // the clean v5 checkpoint skeleton but stretch the topic over 80 chars.
    // All required sub-sections are present in order with (none) placeholders,
    // so no error/extract-required violations fire. Result: 2 warn violations
    // (one per validator) → plugin must leave output untouched regardless.
    const longTopic = "a".repeat(120) // > 80 char limit
    const warnOnlyCheckpoint =
      `Topic: ${longTopic}\n` +
      `\n` +
      `### Execution context\n(none)\n\n` +
      `### Live resources\n(none)\n\n` +
      `### Session metadata\n(none)\n\n` +
      `### Discovered\n(none)\n\n` +
      `### Dead ends\n(none)\n`
    await fs.writeFile(checkpointPath(sessionID), warnOnlyCheckpoint)
    await fs.writeFile(memoryPath(projectID), "## Rules\nshort\n")

    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["actor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object")

    const output: ActorStopOutput = {}
    await reg.run(fakeStopInput(sessionID), output)

    // The fixture produces warn-level violations only (topic-too-long).
    // Plugin output must stay untouched regardless of warn count.
    expect(output.continue).toBeUndefined()
    expect(output.reason).toBeUndefined()
  })

  test("matcher includes checkpoint-writer and excludes other agents", async () => {
    const hooks = await CheckpointSplitoverPlugin(fakeInput(tmpProjectID()))
    const reg = hooks["actor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object")
    const matcher: ActorMatcher | undefined = reg.matcher

    expect(matchesActor(matcher, { mode: "subagent", agentType: "checkpoint-writer" })).toBe(true)

    // Any agentType not in the include list is rejected — independent of BUILT_IN_AGENTS membership.
    expect(matchesActor(matcher, { mode: "subagent", agentType: "general" })).toBe(false)
    expect(matchesActor(matcher, { mode: "subagent", agentType: "build" })).toBe(false)
    expect(matchesActor(matcher, { mode: "subagent", agentType: "summary" })).toBe(false)

    // Non-built-in custom agents also excluded (include is strict)
    expect(matchesActor(matcher, { mode: "subagent", agentType: "custom" })).toBe(false)
  })

  test("CheckpointContext entry with priorTitles → validateLearning catches duplicate-title", async () => {
    const sessionID = tmpSessionID()
    const projectID = tmpProjectID()
    const actorID = "act_dup"
    await setupSession(sessionID, projectID)
    // Pre-populate CheckpointContext so the splitover hook sees a non-empty
    // priorTitles when it runs validateLearning.
    CheckpointContext.set(sessionID, actorID, {
      priorTitles: new Set(["Reuse Bun.file() not fs.readFile"]),
      expectedRevisions: [],
    })
    // Writer's new checkpoint duplicates the prior title in Discovered section.
    // Fixture matches validator's `valid` shape (Topic → Discovered → Dead ends)
    // because extractDiscoveredEntries' regex anchors at start-of-body and
    // doesn't accept intervening snapshot sections. Missing snapshot sections
    // will also emit subsection-missing errors that ride alongside the
    // duplicate-title error into the same `<system-reminder>` envelope — fine
    // for what this test exercises (the priorTitles wire-through).
    const dupCheckpoint = `Topic: writer-output

### Discovered
- Reuse Bun.file() not fs.readFile
  Why: faster
  How to apply: replace fs.readFile sites

### Dead ends
(none)
`
    await fs.writeFile(checkpointPath(sessionID), dupCheckpoint)
    await fs.writeFile(memoryPath(projectID), "## Rules\nx\n")

    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["actor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object")

    const output: ActorStopOutput = {}
    const input: ActorPreStopInput = { ...fakeStopInput(sessionID), actorID }
    await reg.run(input, output)

    expect(output.continue).toBe(true)
    // The duplicate-title violation goes through the error branch
    // (validateLearning emits severity:"error" rule "discovered-duplicate-title"),
    // so the reason starts with the system-reminder envelope and includes the
    // violation detail (which embeds the duplicated title verbatim).
    expect(output.reason).toContain("<system-reminder>")
    expect(output.reason).toContain("duplicates a prior checkpoint")
    expect(output.reason).toContain("Reuse Bun.file() not fs.readFile")
  })

  test("no CheckpointContext entry: fallback to empty (D₁ behaviour)", async () => {
    const sessionID = tmpSessionID()
    const projectID = tmpProjectID()
    await setupSession(sessionID, projectID)
    // No CheckpointContext.set call — entry is missing.
    // Write a clean checkpoint so without priorTitles, no validateLearning
    // violation can fire. Plugin should fall back to EMPTY_CTX and produce
    // no reentry signal.
    await fs.writeFile(checkpointPath(sessionID), CLEAN_CHECKPOINT)
    await fs.writeFile(memoryPath(projectID), CLEAN_MEMORY)

    const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
    const reg = hooks["actor.preStop"]
    if (!reg || typeof reg === "function") throw new Error("expected registration object")

    const output: ActorStopOutput = {}
    await reg.run(fakeStopInput(sessionID), output)

    expect(output.continue).toBeUndefined()
    expect(output.reason).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Regression: child-session writer (Axis A) must read PARENT's checkpoint.md
  // -------------------------------------------------------------------------
  // Post-Axis-A, the writer runs under a fresh child session: input.sessionID
  // is the child's id, but the writer composes checkpoint.md / memory.md at
  // paths derived from the PARENT's session id. Without a parentSessionID
  // fallback, the splitover plugin reads checkpointPath(child) → file missing
  // → false `topic-missing` error → wrong-path retry loop. Ditto for
  // CheckpointContext lookup (set by parent, looked up by child = miss).
  //
  // Fix: the plugin reads `(parentSessionID ?? sessionID)` so:
  //   • checkpoint-writer (parent ≠ child) reads from parent's path.
  //   • dream/distill (parent === child === sessionID) keep working via the
  //     fallback.
  describe("parentSessionID fallback (child-session writer)", () => {
    test("clean parent's checkpoint + child's input.sessionID → no violation", async () => {
      const parentID = tmpSessionID()
      const childID = tmpSessionID()
      const projectID = tmpProjectID()
      // Provision PARENT's metaDir + write a clean checkpoint there.
      // CHILD's metaDir is intentionally NOT created — proves the plugin
      // does not consult the child's path.
      await setupSession(parentID, projectID)
      await fs.writeFile(checkpointPath(parentID), CLEAN_CHECKPOINT)
      await fs.writeFile(memoryPath(projectID), CLEAN_MEMORY)

      const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
      const reg = hooks["actor.preStop"]
      if (!reg || typeof reg === "function") throw new Error("expected registration object")

      // Simulate the post-Axis-A spawn shape: sessionID=child, parentSessionID=parent.
      const input: ActorPreStopInput = { ...fakeStopInput(childID), parentSessionID: parentID }
      const output: ActorStopOutput = {}
      await reg.run(input, output)

      // No violation → output untouched. Without the fallback the plugin would
      // read checkpointPath(child) → missing → set continue=true with a
      // topic-missing error, failing this assertion.
      expect(output.continue).toBeUndefined()
      expect(output.reason).toBeUndefined()
    })

    test("CheckpointContext is also keyed on parent: child-only lookup misses", async () => {
      const parentID = tmpSessionID()
      const childID = tmpSessionID()
      const projectID = tmpProjectID()
      const actorID = "act_dup_child"
      await setupSession(parentID, projectID)
      // Producer (tryStartCheckpointWriter) seeds CheckpointContext keyed on
      // the PARENT session. The plugin must look up by parent too — otherwise
      // priorTitles is always empty and validateLearning never catches dupes.
      CheckpointContext.set(parentID, actorID, {
        priorTitles: new Set(["Reuse Bun.file() not fs.readFile"]),
        expectedRevisions: [],
      })
      // Writer's new checkpoint duplicates the prior title in Discovered.
      const dupCheckpoint = `Topic: writer-output

### Discovered
- Reuse Bun.file() not fs.readFile
  Why: faster
  How to apply: replace fs.readFile sites

### Dead ends
(none)
`
      await fs.writeFile(checkpointPath(parentID), dupCheckpoint)
      await fs.writeFile(memoryPath(projectID), CLEAN_MEMORY)

      const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
      const reg = hooks["actor.preStop"]
      if (!reg || typeof reg === "function") throw new Error("expected registration object")

      const input: ActorPreStopInput = {
        ...fakeStopInput(childID),
        actorID,
        parentSessionID: parentID,
      }
      const output: ActorStopOutput = {}
      await reg.run(input, output)

      // Duplicate-title violation must fire — proves both file path AND
      // CheckpointContext use the parent's session.
      expect(output.continue).toBe(true)
      expect(output.reason).toContain("duplicates a prior checkpoint")
      expect(output.reason).toContain("Reuse Bun.file() not fs.readFile")
    })

    test("dream/distill shape (no parentSessionID) still works via fallback", async () => {
      // For agents that don't get the child-session redirect, parent === child
      // and parentSessionID is undefined. The `?? sessionID` fallback must
      // preserve current behavior.
      const sessionID = tmpSessionID()
      const projectID = tmpProjectID()
      await setupSession(sessionID, projectID)
      await fs.writeFile(checkpointPath(sessionID), CLEAN_CHECKPOINT)
      await fs.writeFile(memoryPath(projectID), CLEAN_MEMORY)

      const hooks = await CheckpointSplitoverPlugin(fakeInput(projectID))
      const reg = hooks["actor.preStop"]
      if (!reg || typeof reg === "function") throw new Error("expected registration object")

      // No parentSessionID set — same shape as today's dream/distill.
      const output: ActorStopOutput = {}
      await reg.run(fakeStopInput(sessionID), output)

      expect(output.continue).toBeUndefined()
      expect(output.reason).toBeUndefined()
    })
  })
})
