import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { nextWorkflowRun, type WorkflowRun } from "../../../src/cli/cmd/tui/context/sync"

// `workflow.started` mints a FRESH run row, but solid MERGES plain objects into
// the existing store node. A resume reuses the SAME runID (runtime.ts:1577 hands
// input.runID back to launch, which republishes WorkflowStarted at :712), so the
// "fresh" row used to inherit the previous attempt's currentPhase and error.
//
// The real store lives inside the SyncProvider factory, which needs the sdk /
// project contexts and a bootstrap; there is no Solid render harness for the
// session route, so the behavioural tests below drive a store wired exactly as the
// "workflow.started" case wires it and pin nextWorkflowRun's SEMANTICS. That the
// event handler actually routes through it is pinned by the source-level (textual,
// NOT behavioural) assertion at the bottom of this file.
function harness() {
  return createRoot((dispose) => {
    const [store, setStore] = createStore<{ workflow: Record<string, WorkflowRun> }>({ workflow: {} })
    return {
      store,
      // Mirrors the "workflow.started" case in sync.tsx.
      started: (runID: string, sessionID: string, name: string) =>
        setStore(
          "workflow",
          runID,
          nextWorkflowRun({ runID, sessionID, name, status: "running", running: 0, succeeded: 0, failed: 0 }),
        ),
      // Mirrors loadWorkflows() / the "workflow.phase" and "workflow.finished" cases.
      phase: (runID: string, title: string) => setStore("workflow", runID, "currentPhase", title),
      finished: (runID: string, status: string) => setStore("workflow", runID, "status", status),
      fail: (runID: string, error: string) => setStore("workflow", runID, "error", error),
      dispose,
    }
  })
}

describe("nextWorkflowRun", () => {
  test("a resumed run does not inherit the dead attempt's phase or error", () => {
    const h = harness()
    h.started("run_1", "ses_1", "deep-research")
    h.phase("run_1", "Research")
    h.fail("run_1", "agent timed out")
    h.finished("run_1", "failed")
    expect(h.store.workflow["run_1"].currentPhase).toBe("Research")

    // resumeWorkflow(runID) -> WorkflowRuntime.resume -> launch(..., input.runID)
    // republishes workflow.started for the SAME runID.
    h.started("run_1", "ses_1", "deep-research")
    expect(h.store.workflow["run_1"].currentPhase).toBeUndefined()
    expect(h.store.workflow["run_1"].error).toBeUndefined()
    expect(h.store.workflow["run_1"]).toEqual({
      runID: "run_1",
      sessionID: "ses_1",
      name: "deep-research",
      status: "running",
      running: 0,
      succeeded: 0,
      failed: 0,
    })
    h.dispose()
  })

  test("a restart drops the phase a prior attempt reached", () => {
    const h = harness()
    h.started("run_2", "ses_2", "fact-check")
    h.phase("run_2", "Crosscheck")
    h.finished("run_2", "cancelled")

    h.started("run_2", "ses_2", "fact-check")
    expect(h.store.workflow["run_2"].status).toBe("running")
    expect(h.store.workflow["run_2"].currentPhase).toBeUndefined()
    h.dispose()
  })

  test("the first start for an unseen runID is stored as-is", () => {
    const h = harness()
    h.started("run_3", "ses_3", "compose")
    expect(h.store.workflow["run_3"]).toEqual({
      runID: "run_3",
      sessionID: "ses_3",
      name: "compose",
      status: "running",
      running: 0,
      succeeded: 0,
      failed: 0,
    })
    h.dispose()
  })

  test("a start for one runID leaves a sibling run untouched", () => {
    const h = harness()
    h.started("run_4", "ses_4", "compose")
    h.phase("run_4", "Implement")
    h.started("run_5", "ses_4", "deep-research")
    expect(h.store.workflow["run_4"].currentPhase).toBe("Implement")
    expect(h.store.workflow["run_5"].currentPhase).toBeUndefined()
    h.dispose()
  })
})

// SOURCE-LEVEL, NOT BEHAVIOURAL. The tests above wire their own store, so they
// would still pass if the "workflow.started" case stopped reconciling. This reads
// the production file so a revert at the real write site fails here.
describe("context/sync.tsx wiring", () => {
  const source = readFileSync(path.join(import.meta.dir, "../../../src/cli/cmd/tui/context/sync.tsx"), "utf8")
  const normalized = source.replace(/\s+/g, " ")
  const count = (needle: string) => normalized.split(needle).length - 1

  test("the workflow.started upsert goes through nextWorkflowRun", () => {
    expect(count(`setStore( "workflow", event.properties.runID, nextWorkflowRun({`)).toBe(1)
  })

  test("loadWorkflows already reconciled the same node and still does", () => {
    // The list route was the ONLY writer of this node that replaced rather than
    // merged; the event handler disagreeing with it was the bug. Pin both sides so
    // they cannot drift apart again.
    expect(count(`setStore("workflow", run.runID, reconcile(run))`)).toBe(1)
  })

  test("the per-field phase/status writes stay targeted merges", () => {
    // Unchanged behaviour: these address a single field and must NOT prune the row.
    expect(count(`setStore("workflow", event.properties.runID, "currentPhase", event.properties.title)`)).toBe(1)
    expect(count(`setStore("workflow", event.properties.runID, "status", event.properties.status)`)).toBe(1)
  })
})
