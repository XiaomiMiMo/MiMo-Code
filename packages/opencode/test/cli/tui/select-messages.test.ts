import { describe, test, expect } from "bun:test"
import { bucketMessages, selectMessages } from "../../../src/cli/cmd/tui/context/sync"

const msg = (id: string, agentID?: string) => ({ id, agentID }) as any

describe("selectMessages", () => {
  test("renders the main bucket for a normal session", () => {
    const buckets = bucketMessages([msg("m1"), msg("m2", "explore-1")])
    expect(selectMessages(buckets, "main", "ses_root")).toEqual([msg("m1")])
  })

  test("renders the requested subagent bucket when the route carries an agentID", () => {
    const buckets = bucketMessages([msg("m1"), msg("m2", "explore-1")])
    expect(selectMessages(buckets, "explore-1", "ses_root")).toEqual([msg("m2", "explore-1")])
  })

  test("falls back to the self-id bucket for a peer child (spawn.ts)", () => {
    const buckets = bucketMessages([msg("m1", "ses_peer"), msg("m2", "ses_peer")])
    expect(selectMessages(buckets, "main", "ses_peer")).toEqual([msg("m1", "ses_peer"), msg("m2", "ses_peer")])
  })

  // INVERTED IN THIS PR. These two cases previously asserted the opposite:
  // "renders an actor-hosted session whose only bucket is its actor id" and
  // "picks the newest bucket when an empty-main session has several actor
  // buckets". That was arm 4 of selectMessages — a fallback added to stop
  // `mimo -s <actor-hosted-id>` showing a blank pane over a full transcript.
  //
  // Rendering those sessions is no longer the requirement: the same PR forbids
  // the TUI from opening an internal-machinery session at all
  // (routes/session/index.tsx + session/visibility.ts). Measured on a 5.4 GB
  // local DB, arm 4's entire population — 1295 sessions, 0 roots, 0 with a
  // mode:"peer" actor row, buckets checkpoint-writer-N (1284), build-N (7),
  // compose-N (3), general-N (1) — is refused by that guard, so arm 4 had no
  // legitimate population left. The blank pane is fixed by making the session
  // unreachable, not by rendering machinery the product hides. These tests now
  // pin that the fallback stays deleted.
  test("does NOT fall back to an actor-hosted bucket (prohibition, not blank-pane fallback)", () => {
    const buckets = bucketMessages([
      msg("m1", "checkpoint-writer-1"),
      msg("m2", "checkpoint-writer-1"),
      msg("m3", "checkpoint-writer-1"),
    ])
    expect(selectMessages(buckets, "main", "ses_actorhost")).toEqual([])
  })

  test("does NOT pick the newest bucket when an empty-main session has several actor buckets", () => {
    const buckets = bucketMessages([msg("m1", "general-1"), msg("m9", "general-2")])
    expect(selectMessages(buckets, "main", "ses_actorhost")).toEqual([])
  })

  test("an explicit agentID still reaches an actor bucket (subagent dialog is unaffected)", () => {
    const buckets = bucketMessages([msg("m1", "checkpoint-writer-1")])
    expect(selectMessages(buckets, "checkpoint-writer-1", "ses_actorhost")).toEqual([
      msg("m1", "checkpoint-writer-1"),
    ])
  })

  test("stays empty when the session genuinely has no messages", () => {
    expect(selectMessages(undefined, "main", "ses_new")).toEqual([])
    expect(selectMessages({}, "main", "ses_new")).toEqual([])
  })
})
