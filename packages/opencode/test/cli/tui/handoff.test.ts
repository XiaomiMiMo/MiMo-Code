import { describe, expect, test } from "bun:test"
import { detectionFromPart, formatHarnessReminder, handoffTargets } from "../../../src/cli/cmd/tui/util/handoff"
import { dict as en } from "../../../src/cli/cmd/tui/i18n/en"
import { dict as es } from "../../../src/cli/cmd/tui/i18n/es"
import { dict as fr } from "../../../src/cli/cmd/tui/i18n/fr"
import { dict as ja } from "../../../src/cli/cmd/tui/i18n/ja"
import { dict as ru } from "../../../src/cli/cmd/tui/i18n/ru"
import { dict as zh } from "../../../src/cli/cmd/tui/i18n/zh"
import { dict as zht } from "../../../src/cli/cmd/tui/i18n/zht"

const i18nKeys = [
  "tui.toast.try_best.paused_other",
  "tui.toast.try_best.handoff_failed",
  "tui.toast.try_best.continue_failed",
  "tui.dialog.try_best.title",
  "tui.dialog.try_best.reason.edit_repeat",
  "tui.dialog.try_best.reason.edit_repeat_path",
  "tui.dialog.try_best.reason.bash_retry",
  "tui.dialog.try_best.reason.action_streak",
  "tui.dialog.try_best.action.edit",
  "tui.dialog.try_best.action.verify",
  "tui.dialog.try_best.action.same_kind",
  "tui.dialog.try_best.handoff.title",
  "tui.dialog.try_best.handoff.description",
  "tui.dialog.try_best.continue.title",
  "tui.dialog.try_best.continue.description",
] as const

describe("try-best handoff", () => {
  test("translates the dialog in every TUI locale", () => {
    const dictionaries: ReadonlyArray<Record<string, string>> = [en, es, fr, ja, ru, zh, zht]
    dictionaries.forEach((dict) => i18nKeys.forEach((key) => expect(dict[key]).toBeTruthy()))
  })

  test("excludes the current model family", () => {
    expect(handoffTargets("openai", "gpt-5-codex")).toEqual(["claude"])
    expect(handoffTargets("anthropic", "claude-sonnet-4")).toEqual(["codex"])
    expect(handoffTargets("mimo", "mimo-v2")).toEqual(["codex", "claude"])
  })

  test("recovers handoff detection from the persisted synthetic part", () => {
    expect(
      detectionFromPart({
        type: "text",
        sessionID: "ses_1",
        metadata: {
          origin: {
            kind: "try_best",
            providerID: "mimo",
            modelID: "mimo-v2",
            incident: {
              reason: "bash_retry",
              evidence: { tool: "bash", command: "bun run ./test/123.ts", count: 3 },
            },
          },
        },
      }),
    ).toEqual({
      sessionID: "ses_1",
      providerID: "mimo",
      modelID: "mimo-v2",
      reason: "bash_retry",
      evidence: { tool: "bash", command: "bun run ./test/123.ts", count: 3 },
    })
  })

  test("creates a synthetic directive for the selected harness", () => {
    const codex = formatHarnessReminder({ target: "codex", detail: "The same command failed twice." })
    expect(codex).toStartWith("<system-reminder>")
    expect(codex).toEndWith("</system-reminder>")
    expect(codex).toContain("user explicitly selected and authorized the Codex CLI harness")
    expect(codex).toContain("MUST load and follow the `codex` skill now")
    expect(codex).toContain("invoke Codex CLI as the primary executor that solves the user's original problem")
    expect(codex).toContain("Do not substitute another harness")
    expect(codex).toContain("send it back to the same harness instead of taking over yourself")
    expect(codex).toContain("Do not stop after merely launching the harness")

    const claude = formatHarnessReminder({ target: "claude", detail: "Repeated edits made no progress." })
    expect(claude).toContain("user explicitly selected and authorized the Claude Code CLI harness")
    expect(claude).toContain("MUST load and follow the `claude-code` skill now")
    expect(claude).toContain("invoke Claude Code CLI as the primary executor that solves the user's original problem")
  })
})
