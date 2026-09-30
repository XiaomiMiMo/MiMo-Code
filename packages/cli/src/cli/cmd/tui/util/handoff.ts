import { isRecord } from "@/util/record"

export type HandoffTarget = "codex" | "claude"

export type HandoffDetection = {
  sessionID: string
  providerID: string
  modelID: string
  reason: "edit_repeat" | "bash_retry" | "action_streak"
  evidence: {
    tool: string
    path?: string
    command?: string
    count: number
    similarity?: number
    action?: "edit" | "verify"
  }
}

export function detectionFromPart(part: {
  type: string
  sessionID: string
  metadata?: Record<string, unknown>
}): HandoffDetection | undefined {
  if (part.type !== "text" || !isRecord(part.metadata?.origin)) return
  const origin = part.metadata.origin
  if (origin.kind !== "try_best" || typeof origin.providerID !== "string" || typeof origin.modelID !== "string") return
  if (!isRecord(origin.incident) || !isRecord(origin.incident.evidence)) return
  const reason = origin.incident.reason
  if (reason !== "edit_repeat" && reason !== "bash_retry" && reason !== "action_streak") return
  const evidence = origin.incident.evidence
  if (typeof evidence.tool !== "string" || typeof evidence.count !== "number") return
  if (evidence.action !== undefined && evidence.action !== "edit" && evidence.action !== "verify") return
  return {
    sessionID: part.sessionID,
    providerID: origin.providerID,
    modelID: origin.modelID,
    reason,
    evidence: {
      tool: evidence.tool,
      count: evidence.count,
      ...(typeof evidence.path === "string" ? { path: evidence.path } : {}),
      ...(typeof evidence.command === "string" ? { command: evidence.command } : {}),
      ...(typeof evidence.similarity === "number" ? { similarity: evidence.similarity } : {}),
      ...(evidence.action === "edit" || evidence.action === "verify" ? { action: evidence.action } : {}),
    },
  }
}

export function handoffTargets(providerID: string, modelID: string): HandoffTarget[] {
  const current = `${providerID}/${modelID}`.toLowerCase()
  const codex = providerID.toLowerCase() === "openai" || /(?:gpt|codex)/.test(current)
  const claude = /(?:anthropic|claude)/.test(current)
  if (codex) return ["claude"]
  if (claude) return ["codex"]
  return ["codex", "claude"]
}

export function formatHarnessReminder(input: { target: HandoffTarget; detail: string }) {
  const skill = input.target === "codex" ? "codex" : "claude-code"
  const harness = input.target === "codex" ? "Codex CLI" : "Claude Code CLI"
  return [
    "<system-reminder>",
    `Try-best loop detection paused the previous turn: ${input.detail}`,
    `The user explicitly selected and authorized the ${harness} harness to take over the unfinished work.`,
    `You MUST load and follow the \`${skill}\` skill now and invoke ${harness} as the primary executor that solves the user's original problem.`,
    `The selected ${harness} must perform the investigation, implementation, fixes, and validation. Do not substitute another harness, merely ask it for advice, or continue solving the task yourself.`,
    "Give the selected harness the complete user goal, relevant workspace state, the failed approach, and all remaining validation requirements. Do not include credentials, secrets, or unrelated private data.",
    `Stay in this CLI and supervise ${harness} until it completes or reaches a concrete blocker. If follow-up work is needed, send it back to the same harness instead of taking over yourself.`,
    "Inspect the harness result and workspace changes, ensure its validation is complete, and report the final outcome to the user. Do not stop after merely launching the harness.",
    "</system-reminder>",
  ].join("\n")
}
