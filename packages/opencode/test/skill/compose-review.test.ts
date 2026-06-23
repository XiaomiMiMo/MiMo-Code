import { describe, expect, test } from "bun:test"
import { loadComposeBundle } from "../../src/skill/compose/bundle.macro"
import { ConfigCompose } from "../../src/config"

const bundle = loadComposeBundle()

describe("compose spec-anchored review contract", () => {
  describe("Task 1: spec section anchors (brainstorm)", () => {
    test("brainstorm SKILL instructs anchor assignment", () => {
      const md = bundle["brainstorm"]["SKILL.md"]
      expect(md).toContain("Spec Section Anchors")
      expect(md).toMatch(/\[S1\]/)
    })

    test("spec-document reviewer checks anchors are present and unique", () => {
      const md = bundle["brainstorm"]["spec-document-reviewer-prompt.md"]
      expect(md).toContain("Anchors")
      expect(md).toMatch(/unique/i)
    })
  })

  describe("Task 2: plan covers field + coverage matrix", () => {
    test("plan SKILL task structure has a Covers field", () => {
      const md = bundle["plan"]["SKILL.md"]
      expect(md).toContain("**Covers:**")
    })

    test("plan SKILL self-review includes a spec-coverage check", () => {
      const md = bundle["plan"]["SKILL.md"]
      expect(md).toMatch(/Covers:.*resolve to a real spec section/is)
    })

    test("plan-document reviewer builds a spec-coverage matrix", () => {
      const md = bundle["plan"]["plan-document-reviewer-prompt.md"]
      expect(md).toContain("Spec Coverage")
      expect(md).toMatch(/matrix/i)
    })
  })

  describe("Task 3: implementer intent injection", () => {
    test("implementer prompt has an Intent section", () => {
      const md = bundle["subagent"]["implementer-prompt.md"]
      expect(md).toContain("## Intent (from spec)")
    })

    test("implementer prompt states a scope boundary", () => {
      const md = bundle["subagent"]["implementer-prompt.md"]
      expect(md).toContain("Scope boundary")
      expect(md).toMatch(/do NOT build other claims/i)
    })
  })

  describe("Task 4: two-phase structured spec reviewer", () => {
    const md = () => bundle["subagent"]["spec-reviewer-prompt.md"]

    test("defines a two-phase protocol", () => {
      expect(md()).toContain("Phase 1")
      expect(md()).toContain("Phase 2")
    })

    test("phase 1 excludes the implementer report", () => {
      expect(md()).toMatch(/no implementer report/i)
    })

    test("phase 2 cannot add passes, only downgrade", () => {
      expect(md()).toMatch(/cannot.*(add|manufacture).*pass/i)
      expect(md()).toMatch(/cannot upgrade.*fail.*pass/is)
      // guard against the contradictory escape hatch: phase 2 must not permit a
      // fail->pass upgrade "without fresh evidence" (that belongs in phase-1 re-review)
      expect(md()).not.toMatch(/upgrade a[\s\S]*?pass[\s\S]*?without fresh evidence/i)
    })

    test("returns structured per-claim verdicts keyed to anchors", () => {
      expect(md()).toContain("in-scope")
      expect(md()).toContain("out-of-scope-for-this-task")
    })

    test("requires verifiable evidence; status without evidence fails", () => {
      expect(md()).toContain("evidence")
      expect(md()).toMatch(/file:line/)
      expect(md()).toContain("unverifiable")
    })
  })

  describe("Task 5: subagent orchestration (gate + two-phase + intent)", () => {
    const md = () => bundle["subagent"]["SKILL.md"]

    test("orchestration injects covered spec text as intent", () => {
      expect(md()).toContain("Intent (from spec)")
    })

    test("orchestration runs spec review in two phases", () => {
      expect(md()).toMatch(/phase 1/i)
      expect(md()).toMatch(/phase 2/i)
    })

    test("defines a completion gate on the structured verdict", () => {
      expect(md()).toMatch(/gate/i)
      expect(md()).toContain("unverifiable")
    })

    test("advises reviewer model tier >= implementer", () => {
      expect(md()).toMatch(/reviewer.*tier|tier.*reviewer/i)
    })
  })

  describe("Task 6: final reviewer anchor-keying", () => {
    test("code reviewer references spec anchors in plan alignment", () => {
      const md = bundle["review"]["code-reviewer.md"]
      expect(md).toMatch(/\[Sn\]|spec anchor/i)
    })
  })

  describe("dispatch vocabulary uses mimocode's actor tool, not Claude Code's", () => {
    const allContent = () =>
      Object.values(bundle).flatMap((files) => Object.values(files))

    test("no bundle file uses Claude Code's 'Task tool' / 'general-purpose' phrasing", () => {
      const offenders = Object.entries(bundle).flatMap(([skill, files]) =>
        Object.entries(files)
          .filter(([, content]) => /Task tool|Task Tool|general-purpose|general_purpose/.test(content))
          .map(([rel]) => `${skill}/${rel}`),
      )
      expect(offenders).toEqual([])
    })

    test("dispatch templates name the real actor tool + general subagent type", () => {
      // The reviewer/implementer prompt templates that dispatch a subagent should
      // name the `actor` tool and the `general` subagent type in prose — and must
      // NOT embed actor's call syntax (operation/discriminator), which lives
      // authoritatively in the actor tool's own description (actor.txt). Embedding
      // a pseudo call block produced malformed calls in a live run.
      for (const rel of ["spec-reviewer-prompt.md", "code-quality-reviewer-prompt.md", "implementer-prompt.md"]) {
        const md = bundle["subagent"][rel]
        expect(md).toMatch(/\bactor\b/)
        expect(md).toMatch(/`general`\s*subagent/)
        // no embedded operation-discriminator call syntax
        expect(md).not.toMatch(/operation:\s*run/)
      }
    })
  })
})

describe("compose docs dir resolution", () => {
  const worktree = "/repo/root"

  test("relative docs is passed through verbatim by default", () => {
    expect(ConfigCompose.resolveDocsDir(worktree, { docs: "docs/compose" })).toBe("docs/compose")
  })

  test("relative docs is anchored to worktree when docs_absolute is true", () => {
    expect(ConfigCompose.resolveDocsDir(worktree, { docs: "docs/compose", docs_absolute: true })).toBe(
      "/repo/root/docs/compose",
    )
  })

  test("absolute docs ignores worktree regardless of docs_absolute", () => {
    expect(ConfigCompose.resolveDocsDir(worktree, { docs: "/abs/docs" })).toBe("/abs/docs")
    expect(ConfigCompose.resolveDocsDir(worktree, { docs: "/abs/docs", docs_absolute: true })).toBe("/abs/docs")
  })

  test("default docs dir is used when config is absent", () => {
    expect(ConfigCompose.resolveDocsDir(worktree, undefined)).toBe(ConfigCompose.DEFAULT_DOCS_DIR)
  })

  test("skill example workflows do not hardcode the default docs/compose prefix", () => {
    const offenders = Object.entries(bundle).flatMap(([skill, files]) =>
      Object.entries(files)
        .filter(([, content]) => content.includes("docs/compose"))
        .map(([rel]) => `${skill}/${rel}`),
    )
    expect(offenders).toEqual([])
  })
})
