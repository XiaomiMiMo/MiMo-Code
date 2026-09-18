import { describe, expect, test } from "bun:test"
import {
  UNCOMMITTED_HINT_PROMPT,
  UNCOMMITTED_HINT_CONFIG_PARSE_FAILED,
  beginPendingHint,
  buildHintText,
  cancelMainHintToken,
  cancelPendingHints,
  clearAllHintStateForSession,
  clearHintCount,
  clearHintStateForDirectory,
  clearPendingHints,
  currentMainHintToken,
  decideUncommittedHint,
  beginHintStateDisposeForDirectory,
  hookNonTextRequiresProvenance,
  endPendingHint,
  getHintCount,
  hasMainHintToken,
  hasPendingHintRows,
  hasHintDirectoryIndex,
  hintDirectoryIndexSize,
  hintClaimBarrier,
  hintFirePostBarrier,
  hintGitProbeBarrier,
  isPendingHintLive,
  isWorkingTreeDirty,
  nextHintCount,
  normalizePorcelain,
  openMainHintToken,
  recordHintOutcome,
  resetHintCounters,
  resetHintExecState,
  resolveUncommittedHintConfig,
  uncommittedHintConfigFromConfigContent,
  uncommittedHintEnabledFromConfig,
  uncommittedHintLogFields,
} from "../../src/session/prompt/uncommitted-hint"

describe("uncommitted-hint config", () => {
  test("[TP-R2-02] default off", () => {
    expect(uncommittedHintEnabledFromConfig(undefined)).toBe(false)
    expect(uncommittedHintEnabledFromConfig({ enabled: false })).toBe(false)
  })
  test("[TP-R2-01] explicit true enables", () => {
    expect(uncommittedHintEnabledFromConfig({ enabled: true })).toBe(true)
  })
  test("[TP-R2-01][TP-R2-02] live CONFIG_CONTENT parse for mid-session toggle", () => {
    expect(
      uncommittedHintConfigFromConfigContent(
        JSON.stringify({ experimental: { uncommitted_hint: { enabled: true } } }),
      ),
    ).toEqual({ enabled: true })
    expect(uncommittedHintConfigFromConfigContent(JSON.stringify({ experimental: {} }))).toBeUndefined()
    expect(uncommittedHintConfigFromConfigContent(undefined)).toBeUndefined()
    expect(uncommittedHintConfigFromConfigContent("{not-json")).toBe("parse-failed")
  })
  test("[TP-R3-01][TP-R2-01] resolve: cached on → live explicit off → effective off", () => {
    const off = resolveUncommittedHintConfig({
      liveContent: JSON.stringify({ experimental: { uncommitted_hint: { enabled: false } } }),
      cached: { enabled: true },
    })
    expect(off?.enabled).toBe(false)
  })
  test("[TP-R3-01] resolve: live env present but key absent → cached/file wins", () => {
    const fromFile = resolveUncommittedHintConfig({
      liveContent: JSON.stringify({ experimental: { loop_streak_recovery: { enabled: true } } }),
      cached: { enabled: true },
    })
    expect(fromFile?.enabled).toBe(true)
  })
  test("[TP-R3-01] resolve: live explicit off overrides cached on when env has other keys", () => {
    const off = resolveUncommittedHintConfig({
      liveContent: JSON.stringify({
        experimental: {
          loop_streak_recovery: { enabled: true },
          uncommitted_hint: { enabled: false },
        },
      }),
      cached: { enabled: true },
    })
    expect(off?.enabled).toBe(false)
  })
  test("[TP-R2-02] resolve: no live env → cached/file wins", () => {
    expect(resolveUncommittedHintConfig({ cached: { enabled: true } })?.enabled).toBe(true)
    expect(resolveUncommittedHintConfig({ cached: undefined })?.enabled).toBeUndefined()
  })
  test("[TP-R2-02] live uncommitted_hint:null fails closed instead of throwing", () => {
    expect(
      resolveUncommittedHintConfig({
        liveContent: JSON.stringify({ experimental: { uncommitted_hint: null } }),
        cached: { enabled: true },
      })?.enabled,
    ).toBe(false)
  })
  test("[TP-R2-02] empty live CONFIG_CONTENT fails closed; undefined live uses cached", () => {
    expect(resolveUncommittedHintConfig({ liveContent: "", cached: { enabled: true } })?.enabled).toBe(false)
    expect(resolveUncommittedHintConfig({ liveContent: undefined, cached: { enabled: true } })?.enabled).toBe(true)
    expect(uncommittedHintConfigFromConfigContent("")).toBe(UNCOMMITTED_HINT_CONFIG_PARSE_FAILED)
    expect(uncommittedHintConfigFromConfigContent(undefined)).toBeUndefined()
  })
  test("[TP-R2-02] malformed live CONFIG_CONTENT fails closed and does not revive cached on", () => {
    const broken = resolveUncommittedHintConfig({
      liveContent: "{not-json",
      cached: { enabled: true },
    })
    expect(broken?.enabled).toBe(false)
    // Valid live JSON without the key still falls back to cached.
    const noKey = resolveUncommittedHintConfig({
      liveContent: JSON.stringify({ experimental: { other: 1 } }),
      cached: { enabled: true },
    })
    expect(noKey?.enabled).toBe(true)
  })
})

describe("decideUncommittedHint — product vs anti-loop", () => {
  const base = {
    enabled: true,
    outcome: "completed" as const,
    agentID: "main",
    hasDirectory: true,
    isGitRepo: true,
    dirty: true,
    consecutiveHints: 0,
    turnSource: "user" as const,
  }
  test("[TP-R1-01] dirty user turn injects", () => {
    expect(decideUncommittedHint(base)).toEqual({ action: "inject", reason: "dirty" })
  })
  test("[TP-R4-01] hook-source turn never injects (fail-closed anti-loop)", () => {
    expect(decideUncommittedHint({ ...base, turnSource: "hook" })).toEqual({
      action: "skip",
      reason: "non_user_source",
    })
  })
  test("[TP-R4-01] undefined / spawn source never injects", () => {
    expect(decideUncommittedHint({ ...base, turnSource: undefined }).reason).toBe("non_user_source")
    expect(decideUncommittedHint({ ...base, turnSource: "spawn" }).reason).toBe("non_user_source")
  })
  test("[TP-R4-02] later dirty USER turns re-hint (no session-once hard cap)", () => {
    expect(decideUncommittedHint({ ...base, consecutiveHints: 1 })).toEqual({
      action: "inject",
      reason: "dirty",
    })
    expect(decideUncommittedHint({ ...base, consecutiveHints: 5 }).reason).toBe("dirty")
  })
  test("[TP-R4-03] no max_consecutive config; schema enabled-only", async () => {
    const src = await Bun.file(new URL("../../src/config/config.ts", import.meta.url)).text()
    const idx = src.indexOf("uncommitted_hint:")
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 500)
    expect(block).toContain("enabled")
    expect(block).not.toContain("max_consecutive")
    expect(block).not.toContain("UNCOMMITTED_HINT_MAX_CONSECUTIVE")
    expect(block).not.toContain("at most one soft hint per session")
  })
  test("[TP-R1-02][TP-R5-01] clean / disabled / wrong outcome / non-main / no dir / not repo skip", () => {
    expect(decideUncommittedHint({ ...base, dirty: false }).reason).toBe("clean")
    expect(decideUncommittedHint({ ...base, enabled: false }).reason).toBe("disabled")
    expect(decideUncommittedHint({ ...base, outcome: "error" }).reason).toBe("bad_outcome")
    expect(decideUncommittedHint({ ...base, outcome: "cancelled" }).reason).toBe("bad_outcome")
    expect(decideUncommittedHint({ ...base, agentID: "plan" }).reason).toBe("not_main")
    expect(decideUncommittedHint({ ...base, hasDirectory: false }).reason).toBe("no_directory")
    expect(decideUncommittedHint({ ...base, isGitRepo: false }).reason).toBe("not_repo")
  })
  test("[TP-R1-01] hint asks gitignore review then stage and commit", () => {
    const p = UNCOMMITTED_HINT_PROMPT.toLowerCase()
    expect(p).toContain("gitignore")
    expect(p).toContain("stage")
    expect(p).toContain("commit")
    expect(p).not.toContain("must commit")
  })
  test("[TP-R7-01] decision log fields carry decision/reason/turnSource/enabled", () => {
    const inject = decideUncommittedHint(base)
    expect(
      uncommittedHintLogFields({
        decision: inject.action,
        reason: inject.reason,
        enabled: base.enabled,
        turnSource: base.turnSource,
        dirty: base.dirty,
      }),
    ).toEqual({
      decision: "inject",
      reason: "dirty",
      enabled: true,
      turnSource: "user",
      dirty: true,
    })
    const skip = decideUncommittedHint({ ...base, turnSource: "hook" })
    expect(
      uncommittedHintLogFields({
        decision: skip.action,
        reason: skip.reason,
        enabled: true,
        turnSource: "hook",
      }),
    ).toMatchObject({ decision: "skip", reason: "non_user_source", turnSource: "hook" })
  })
  test("[TP-R4-01] cancel targets main token; child runLoop must not overwrite it", () => {
    resetHintExecState("ses_tok")
    const mainTok = openMainHintToken("ses_tok")
    const pendingMain = beginPendingHint("ses_tok", mainTok)
    expect(isPendingHintLive(pendingMain)).toBe(true)
    expect(hasMainHintToken("ses_tok")).toBe(true)
    cancelMainHintToken("ses_tok")
    expect(isPendingHintLive(pendingMain)).toBe(false)
    const late = beginPendingHint("ses_tok", mainTok)
    expect(isPendingHintLive(late)).toBe(false)
    const mainTok2 = openMainHintToken("ses_tok")
    const pending2 = beginPendingHint("ses_tok", mainTok2)
    expect(isPendingHintLive(pending2)).toBe(true)
    endPendingHint(pending2)
    resetHintExecState("ses_tok")
  })
  test("[TP-R4-01] session delete clearAllHintStateForSession drops directory index", () => {
    resetHintExecState()
    openMainHintToken("ses_del", "/example/ws-del")
    recordHintOutcome("ses_del", { dirty: true, injected: true, consecutiveHints: 0 })
    expect(hasHintDirectoryIndex("ses_del")).toBe(true)
    expect(hintDirectoryIndexSize()).toBeGreaterThan(0)
    clearAllHintStateForSession("ses_del")
    // These three were already true under the old leaky cleanup — not sufficient alone.
    expect(currentMainHintToken("ses_del")).toBeUndefined()
    expect(getHintCount("ses_del")).toBe(0)
    // Index row is the leak detector.
    expect(hasHintDirectoryIndex("ses_del")).toBe(false)
  })
  test("[TP-R4-01] negative control: legacy cleanup leaves directory index; production cleanup does not", () => {
    resetHintExecState()
    openMainHintToken("ses_legacy", "/example/ws-legacy")
    recordHintOutcome("ses_legacy", { dirty: true, injected: true, consecutiveHints: 0 })
    // Old delete path: cancel + clearPending + clearCount only.
    cancelPendingHints("ses_legacy")
    clearPendingHints("ses_legacy")
    clearHintCount("ses_legacy")
    expect(currentMainHintToken("ses_legacy")).toBeUndefined()
    expect(getHintCount("ses_legacy")).toBe(0)
    // This is the original bug: index survives.
    expect(hasHintDirectoryIndex("ses_legacy")).toBe(true)
    // Production path must drop the index.
    clearAllHintStateForSession("ses_legacy")
    expect(hasHintDirectoryIndex("ses_legacy")).toBe(false)
  })
  test("[TP-R4-01] orphan dispose finisher keeps replacement directory index", () => {
    resetHintExecState()
    const dir = "/example/ws-orphan-repl"
    openMainHintToken("ses_orphan_r", dir)
    cancelPendingHints("ses_orphan_r")
    clearPendingHints("ses_orphan_r")
    clearHintCount("ses_orphan_r")
    expect(hasHintDirectoryIndex("ses_orphan_r")).toBe(true)
    const finish = beginHintStateDisposeForDirectory(dir)
    // Replacement token + index during dispose wait.
    openMainHintToken("ses_orphan_r", dir)
    expect(hasHintDirectoryIndex("ses_orphan_r")).toBe(true)
    finish()
    expect(currentMainHintToken("ses_orphan_r")?.cancelled).toBe(false)
    expect(hasHintDirectoryIndex("ses_orphan_r")).toBe(true)
    resetHintExecState()
  })
  test("[TP-R4-01] dispose finisher drops orphan directory-index rows without live tokens", () => {
    resetHintExecState()
    openMainHintToken("ses_orphan", "/example/ws-orphan")
    // Simulate old leaky delete: token/count gone, index remains.
    cancelPendingHints("ses_orphan")
    clearPendingHints("ses_orphan")
    clearHintCount("ses_orphan")
    expect(currentMainHintToken("ses_orphan")).toBeUndefined()
    expect(hasHintDirectoryIndex("ses_orphan")).toBe(true)
    const finish = beginHintStateDisposeForDirectory("/example/ws-orphan")
    finish()
    expect(hasHintDirectoryIndex("ses_orphan")).toBe(false)
  })
  test("[TP-R4-01] beginHintStateDisposeForDirectory leaves replacement tokens intact", () => {
    resetHintExecState()
    openMainHintToken("ses_old", "/example/ws-x")
    const finish = beginHintStateDisposeForDirectory("/example/ws-x")
    expect(currentMainHintToken("ses_old")?.cancelled).toBe(true)
    // Replacement instance opens a new token on the same session during dispose.
    openMainHintToken("ses_old", "/example/ws-x")
    finish()
    expect(currentMainHintToken("ses_old")?.cancelled).toBe(false)
    expect(getHintCount("ses_old")).toBe(0)
    resetHintExecState()
  })
  test("[TP-R4h-01] github hook+file requires provenance; with provenance allowed", () => {
    expect(
      hookNonTextRequiresProvenance({
        source: "hook",
        parts: [{ type: "file" }],
      }),
    ).toBe(true)
    expect(
      hookNonTextRequiresProvenance({
        source: "hook",
        provenance: { machine: "mimocode-github" },
        parts: [{ type: "file" }],
      }),
    ).toBe(false)
    expect(
      hookNonTextRequiresProvenance({
        source: "hook",
        parts: [{ type: "text" }],
      }),
    ).toBe(false)
  })
  test("[TP-R4-01] clearHintStateForDirectory only clears that workspace", () => {
    resetHintExecState()
    openMainHintToken("ses_dir_a", "/example/ws-a")
    openMainHintToken("ses_dir_b", "/example/ws-b")
    recordHintOutcome("ses_dir_a", { dirty: true, injected: true, consecutiveHints: 0 })
    recordHintOutcome("ses_dir_b", { dirty: true, injected: true, consecutiveHints: 0 })
    clearHintStateForDirectory("/example/ws-a")
    expect(getHintCount("ses_dir_a")).toBe(0)
    expect(currentMainHintToken("ses_dir_a")).toBeUndefined()
    expect(getHintCount("ses_dir_b")).toBe(1)
    expect(currentMainHintToken("ses_dir_b")?.cancelled).toBe(false)
    resetHintExecState()
  })
  test("[TP-R4-01] openMainHintToken cancels prior main token + pending; cancelPendingHints is session-wide", () => {
    resetHintExecState("ses_reopen")
    const tokA = openMainHintToken("ses_reopen")
    const pendingA = beginPendingHint("ses_reopen", tokA)
    expect(isPendingHintLive(pendingA)).toBe(true)
    const tokB = openMainHintToken("ses_reopen")
    expect(tokA.cancelled).toBe(true)
    expect(tokB.cancelled).toBe(false)
    expect(isPendingHintLive(pendingA)).toBe(false)
    const pendingB = beginPendingHint("ses_reopen", tokB)
    expect(isPendingHintLive(pendingB)).toBe(true)
    // Session cancel invalidates every pending handle, not only current-token ones.
    const orphanTok = { cancelled: false }
    const orphan = beginPendingHint("ses_reopen", orphanTok)
    cancelPendingHints("ses_reopen")
    expect(isPendingHintLive(pendingB)).toBe(false)
    expect(isPendingHintLive(orphan)).toBe(false)
    expect(currentMainHintToken("ses_reopen")?.cancelled).toBe(true)
    resetHintExecState("ses_reopen")
  })
  test("[TP-R4-01] clearPendingHints disposes token + pending rows (R011)", () => {
    resetHintExecState("ses_clean")
    const tok = openMainHintToken("ses_clean")
    const pending = beginPendingHint("ses_clean", tok)
    expect(hasMainHintToken("ses_clean")).toBe(true)
    expect(hasPendingHintRows("ses_clean")).toBe(true)
    clearPendingHints("ses_clean")
    expect(hasMainHintToken("ses_clean")).toBe(false)
    expect(hasPendingHintRows("ses_clean")).toBe(false)
    expect(isPendingHintLive(pending)).toBe(false)
  })
  test("[TP-R4-01] hintClaimBarrier defaults unset", () => {
    expect(hintClaimBarrier.onReached).toBeUndefined()
    expect(hintClaimBarrier.wait).toBeUndefined()
    expect(hintGitProbeBarrier.wait).toBeUndefined()
    expect(hintFirePostBarrier.wait).toBeUndefined()
  })
})

// [TP-R4-01][TP-R4-02] Anti-loop vs re-hint: hook/undefined never inject; dirty USER turns may re-inject.
describe("decideUncommittedHint — refuse-commit storm vs re-hint on dirty user turns", () => {
  function step(state: { count: number }, turnSource: "user" | "hook" | undefined) {
    const d = decideUncommittedHint({
      enabled: true,
      outcome: "completed",
      agentID: "main",
      hasDirectory: true,
      isGitRepo: true,
      dirty: true,
      consecutiveHints: state.count,
      turnSource,
    })
    recordHintOutcome("ses_storm", {
      dirty: true,
      injected: d.action === "inject",
      consecutiveHints: state.count,
    })
    return { d, count: getHintCount("ses_storm") }
  }

  test("hook/undefined refuse storm injects 0; each dirty USER turn injects", () => {
    resetHintCounters()
    let state = { count: 0 }
    let injects = 0
    const sequence: Array<"user" | "hook" | undefined> = [
      "user",
      "hook",
      "hook",
      undefined,
      "spawn" as never,
      "user",
      "hook",
      "user",
    ]
    for (const src of sequence) {
      const next = step(state, src as "user" | "hook" | undefined)
      if (next.d.action === "inject") injects++
      state = { count: next.count }
    }
    // three user turns, all dirty → three injects; hooks/undefined/spawn → 0
    expect(injects).toBe(3)
    expect(state.count).toBe(3)
  })
})

describe("hint body + session hint state", () => {
  test("[TP-R1-01] buildHintText keeps gitignore guidance + leading XY porcelain", () => {
    const text = buildHintText(" M a.ts\n?? b.ts\n")
    expect(text.toLowerCase()).toContain("gitignore")
    expect(text).toContain(" M a.ts")
    expect(text).toContain("?? b.ts")
    expect(text).not.toContain("\nM a.ts")
  })
  test("[TP-R4-02] diagnostic counter: inject increments; clean resets; clearHintCount drops", () => {
    expect(nextHintCount(0, true, true)).toBe(1)
    expect(nextHintCount(1, true, true)).toBe(2)
    expect(nextHintCount(2, false, false)).toBe(0)
    expect(nextHintCount(2, true, false)).toBe(2)
    resetHintCounters()
    recordHintOutcome("ses_x", { dirty: true, injected: true, consecutiveHints: 0 })
    expect(getHintCount("ses_x")).toBe(1)
    recordHintOutcome("ses_x", { dirty: true, injected: true, consecutiveHints: 1 })
    expect(getHintCount("ses_x")).toBe(2)
    recordHintOutcome("ses_x", { dirty: false, injected: false, consecutiveHints: 2 })
    expect(getHintCount("ses_x")).toBe(0)
    recordHintOutcome("ses_x", { dirty: true, injected: true, consecutiveHints: 0 })
    expect(getHintCount("ses_x")).toBe(1)
    clearHintCount("ses_x")
    expect(getHintCount("ses_x")).toBe(0)
  })
  test("[TP-R1-02] porcelain dirty parse", () => {
    expect(isWorkingTreeDirty("")).toBe(false)
    expect(isWorkingTreeDirty(" M a.ts\n")).toBe(true)
  })
  test("normalizePorcelain trims and unifies newlines", () => {
    expect(normalizePorcelain(" M a\r\n?? b\n")).toBe(" M a\n?? b")
  })
})
