import { describe, expect, test } from "bun:test"
import { matchesActor } from "../../src/plugin/matcher"

const subAgent = (agentType: string) => ({ mode: "subagent" as const, agentType })
const peerAgent = (agentType: string) => ({ mode: "peer" as const, agentType })

describe("matchesActor", () => {
  describe("undefined matcher", () => {
    test("matches non-builtin subagent", () => {
      expect(matchesActor(undefined, subAgent("custom-validator"))).toBe(true)
    })

    test("excludes builtin checkpoint-writer", () => {
      expect(matchesActor(undefined, subAgent("checkpoint-writer"))).toBe(false)
    })

    test("excludes builtin explore / summary / title / dream / distill / compaction / main / general / build", () => {
      for (const t of ["explore", "summary", "title", "dream", "distill", "compaction", "main", "general", "build"]) {
        expect(matchesActor(undefined, subAgent(t))).toBe(false)
      }
    })

    test("matches non-builtin peer", () => {
      expect(matchesActor(undefined, peerAgent("custom-peer"))).toBe(true)
    })
  })

  describe("mode filter", () => {
    test("subagent-only excludes peer", () => {
      expect(matchesActor({ mode: "subagent" }, peerAgent("custom"))).toBe(false)
    })

    test("subagent-only allows subagent", () => {
      expect(matchesActor({ mode: "subagent" }, subAgent("custom"))).toBe(true)
    })

    test("peer-only excludes subagent", () => {
      expect(matchesActor({ mode: "peer" }, subAgent("custom"))).toBe(false)
    })
  })

  describe("agentType regex string", () => {
    test("matches non-builtin matching regex", () => {
      expect(matchesActor({ agentType: "^review-" }, subAgent("review-auth"))).toBe(true)
    })

    test("does NOT match builtin even if regex matches", () => {
      expect(matchesActor({ agentType: ".*" }, subAgent("checkpoint-writer"))).toBe(false)
    })

    test("does NOT match non-matching regex", () => {
      expect(matchesActor({ agentType: "^review-" }, subAgent("validator"))).toBe(false)
    })

    test("malformed regex returns false instead of throwing", () => {
      expect(matchesActor({ agentType: "(invalid" }, subAgent("custom"))).toBe(false)
    })
  })

  describe("agentType array (explicit list)", () => {
    test("includes listed builtin", () => {
      expect(matchesActor({ agentType: ["checkpoint-writer"] }, subAgent("checkpoint-writer"))).toBe(true)
    })

    test("includes listed non-builtin", () => {
      expect(matchesActor({ agentType: ["validator"] }, subAgent("validator"))).toBe(true)
    })

    test("excludes unlisted", () => {
      expect(matchesActor({ agentType: ["validator"] }, subAgent("other"))).toBe(false)
    })
  })

  describe("agentType include/exclude object", () => {
    test("include allows listed even if builtin", () => {
      expect(matchesActor({ agentType: { include: ["explore"] } }, subAgent("explore"))).toBe(true)
    })

    test("exclude overrides include", () => {
      expect(
        matchesActor({ agentType: { include: ["a", "b"], exclude: ["a"] } }, subAgent("a")),
      ).toBe(false)
    })

    test("not in include returns false (even non-builtin)", () => {
      expect(matchesActor({ agentType: { include: ["a"] } }, subAgent("custom"))).toBe(false)
    })
  })

  describe("combined mode + agentType", () => {
    test("mode filter applied before agentType", () => {
      expect(
        matchesActor({ mode: "subagent", agentType: ["checkpoint-writer"] }, peerAgent("checkpoint-writer")),
      ).toBe(false)
    })
  })
})
