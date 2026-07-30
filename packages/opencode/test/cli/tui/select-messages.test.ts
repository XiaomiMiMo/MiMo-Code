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

  // The blank-transcript bug: an ACTOR-hosted session buckets every message under
  // its actor id, so "main" is empty AND the self-id bucket does not exist. The
  // old reader returned [] here and rendered a blank pane over a full transcript.
  test("renders an actor-hosted session whose only bucket is its actor id", () => {
    const buckets = bucketMessages([
      msg("m1", "checkpoint-writer-1"),
      msg("m2", "checkpoint-writer-1"),
      msg("m3", "checkpoint-writer-1"),
    ])
    expect(selectMessages(buckets, "main", "ses_actorhost")).toEqual([
      msg("m1", "checkpoint-writer-1"),
      msg("m2", "checkpoint-writer-1"),
      msg("m3", "checkpoint-writer-1"),
    ])
  })

  test("picks the newest bucket when an empty-main session has several actor buckets", () => {
    const buckets = bucketMessages([msg("m1", "general-1"), msg("m9", "general-2")])
    expect(selectMessages(buckets, "main", "ses_actorhost")).toEqual([msg("m9", "general-2")])
  })

  test("stays empty when the session genuinely has no messages", () => {
    expect(selectMessages(undefined, "main", "ses_new")).toEqual([])
    expect(selectMessages({}, "main", "ses_new")).toEqual([])
  })
})
