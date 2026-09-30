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

  // REWRITTEN TWICE — read the history before touching these, they have flipped
  // once already.
  //
  // Originally they asserted that an actor-bucketed session renders (the
  // blank-transcript fix). A later commit on this same branch INVERTED them to
  // `toEqual([])` and deleted the fallback, on the reasoning that arm 4's only
  // population was internal machinery which the new render prohibition made
  // unreachable anyway.
  //
  // That reasoning has been narrowed and these are back to asserting rendering.
  // The prohibition no longer keys on "not a peer child" but on the session
  // hosting a RUNTIME-spawned agent (session/visibility.ts →
  // SYSTEM_SPAWNED_AGENT_TYPES). Measured on the live DB, the 1313 sessions this
  // arm serves are 1302 checkpoint-writer hosts — still refused, upstream at the
  // route, before the selector ever runs — plus 11 `session ask` fork-query hosts
  // (buckets build-1 ×7, compose-1 ×3, general-1 ×1) which are model-spawned
  // read-only transcripts the product does display. Those 11 are precisely the
  // blank pane #1964 was opened to fix, so the arm is load-bearing again.
  //
  // The inversion that makes it safe: machinery is refused BEFORE bucket
  // selection, so this fallback can no longer be what renders a checkpoint-writer
  // transcript.
  test("renders an actor-hosted session whose only bucket is its actor id", () => {
    const buckets = bucketMessages([msg("m1", "build-1"), msg("m2", "build-1"), msg("m3", "build-1")])
    expect(selectMessages(buckets, "main", "ses_askfork")).toEqual([
      msg("m1", "build-1"),
      msg("m2", "build-1"),
      msg("m3", "build-1"),
    ])
  })

  test("picks the newest bucket when an empty-main session has several actor buckets", () => {
    const buckets = bucketMessages([msg("m1", "general-1"), msg("m9", "general-2")])
    expect(selectMessages(buckets, "main", "ses_actorhost")).toEqual([msg("m9", "general-2")])
  })

  // The self-id bucket must still win over a newer actor bucket: a peer child that
  // spawned subagents has both, and its own conversation is what to show.
  test("prefers the peer self-id bucket over a newer actor bucket", () => {
    const buckets = bucketMessages([msg("m1", "ses_peer"), msg("m9", "explore-1")])
    expect(selectMessages(buckets, "main", "ses_peer")).toEqual([msg("m1", "ses_peer")])
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
