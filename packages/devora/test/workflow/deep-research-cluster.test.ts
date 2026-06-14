import { describe, expect, test } from "bun:test"
import { evalScript } from "../../src/workflow/sandbox"

// Mirrors the Group step's fold logic from builtin/deep-research.js, run in
// isolation against a stubbed agent so we can pin the collapse / null-fallback /
// url-union behavior without a live model.
const GROUP_STEP = `
  const topFacts = [
    { statement: "v1.3.14 is latest", sourceUrl: "https://a", weight: "key", tier: "primary", excerpt: "q1" },
    { statement: "v1.3.14 latest release", sourceUrl: "https://b", weight: "key", tier: "primary", excerpt: "q2" },
    { statement: "fixes 92 issues", sourceUrl: "https://c", weight: "support", tier: "primary", excerpt: "q3" },
  ]
  const grouped = await agent("group", { schema: {} })
  const groups = grouped && grouped.groups && grouped.groups.length
    ? grouped.groups.map(g => {
        const idx = (g.members || []).filter(i => i >= 0 && i < topFacts.length)
        const head = topFacts[idx[0] != null ? idx[0] : 0]
        const urls = [...new Set((g.urls && g.urls.length ? g.urls : idx.map(i => topFacts[i].sourceUrl)))]
        return { ...head, statement: g.canonical || head.statement, urls }
      })
    : topFacts.map(f => ({ ...f, urls: [f.sourceUrl] }))
  return { count: groups.length, urls: groups.map(g => g.urls) }
`

describe("deep-research group fold", () => {
  test("folds facts into groups with merged urls", async () => {
    const hooks = {
      agent: async () => ({
        groups: [
          { canonical: "v1.3.14 is the latest stable", members: [0, 1], urls: ["https://a", "https://b"] },
          { canonical: "fixes 92 issues", members: [2], urls: ["https://c"] },
        ],
      }),
    }
    const r = (await evalScript(GROUP_STEP, hooks)) as { count: number; urls: string[][] }
    expect(r.count).toBe(2)
    expect(r.urls[0].sort()).toEqual(["https://a", "https://b"])
    expect(r.urls[1]).toEqual(["https://c"])
  })

  test("null group result falls back to per-fact (no crash)", async () => {
    const hooks = { agent: async () => null }
    const r = (await evalScript(GROUP_STEP, hooks)) as { count: number; urls: string[][] }
    expect(r.count).toBe(3)
    expect(r.urls).toEqual([["https://a"], ["https://b"], ["https://c"]])
  })
})
