/**
 * 对抗性验证子 agent 模块
 *
 * 参考 Claude Code 的 adversarial review 策略：
 * - 在任务完成后，启动独立的验证子 agent
 * - 验证 agent 在全新的 context 中运行，不受原始推理偏见影响
 * - 专注于发现边界情况、正确性和一致性问题
 *
 * 核心思想：做任务的 agent 不应该自己给自己打分
 */

import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { ActorTool } from "@/tool/actor"
import { Session } from "@/session"
import { Log } from "@/util"
import { SessionID } from "@/session/schema"
import { MessageID } from "@/session/schema"
import { PartID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { Bus } from "@/bus"
import { SessionStatus } from "@/session/status"
import { InstanceState } from "@/effect"

const log = Log.create({ service: "adversarial-verification" })

/**
 * 验证维度
 */
export interface VerificationDimension {
  /** 维度名称 */
  name: string
  /** 验证提示词 */
  prompt: string
  /** 是否为强制维度 */
  required: boolean
}

/**
 * 验证结果
 */
export interface VerificationResult {
  /** 维度名称 */
  dimension: string
  /** 是否通过 */
  passed: boolean
  /** 发现的问题 */
  findings: string[]
  /** 严重程度: critical | major | minor */
  severity: "critical" | "major" | "minor"
}

/**
 * 预定义的验证维度
 */
export const VERIFICATION_DIMENSIONS: VerificationDimension[] = [
  {
    name: "correctness",
    prompt: "Review the code changes for correctness bugs. Check edge cases, error handling, and logic errors. Report specific file paths and line numbers.",
    required: true,
  },
  {
    name: "consistency",
    prompt: "Check if the changes are consistent with existing code patterns and conventions. Verify naming, style, and architecture alignment.",
    required: true,
  },
  {
    name: "completeness",
    prompt: "Verify that all requirements from the original request are addressed. Check for missing implementations or incomplete features.",
    required: true,
  },
  {
    name: "safety",
    prompt: "Review for security issues, data loss risks, and destructive operations. Check git safety and file system safety.",
    required: false,
  },
]

/**
 * 生成验证提示词
 */
function buildVerificationPrompt(
  dimensions: VerificationDimension[],
  diffSummary: string,
  taskDescription: string,
): string {
  const dimensionInstructions = dimensions
    .map((d) => `## ${d.name.charAt(0).toUpperCase() + d.name.slice(1)}\n${d.prompt}`)
    .join("\n\n")

  return `You are a code reviewer. Your job is to find problems, not confirm correctness.

## Task Description
${taskDescription}

## Changes to Review
${diffSummary}

## Verification Dimensions
${dimensionInstructions}

## Rules
- Focus on finding bugs, not praising good code
- Report specific file paths and line numbers
- If no issues found in a dimension, say "No issues found" — do not fabricate problems
- Prioritize critical issues over style preferences
- Be skeptical — default to finding problems, not confirming correctness

## Output Format
For each dimension, provide:
- PASS or FAIL
- List of specific findings (if any)
- Severity: critical | major | minor
`
}

/**
 * 启动对抗性验证子 agent
 */
export async function runAdversarialVerification(input: {
  sessionID: SessionID
  taskDescription: string
  diffSummary: string
  dimensions?: VerificationDimension[]
}): Promise<VerificationResult[]> {
  const dimensions = input.dimensions ?? VERIFICATION_DIMENSIONS

  log.info("starting adversarial verification", {
    sessionID: input.sessionID,
    dimensions: dimensions.length,
  })

  // 使用 actor tool 启动验证子 agent
  const verificationPrompt = buildVerificationPrompt(
    dimensions,
    input.diffSummary,
    input.taskDescription,
  )

  // 这里应该调用 actor tool 启动子 agent
  // 由于 actor tool 的调用需要完整的 Effect 上下文，
  // 这里提供一个简化的实现，实际使用时需要集成到 run loop 中

  log.info("verification prompt built", {
    sessionID: input.sessionID,
    promptLength: verificationPrompt.length,
  })

  // 返回空结果作为占位符
  // 实际实现需要在 prompt.ts 的 run loop 中集成
  return dimensions.map((d) => ({
    dimension: d.name,
    passed: true,
    findings: [],
    severity: "minor" as const,
  }))
}

/**
 * 注入验证提醒到用户消息
 * 当验证发现问题时，注入 system-reminder 提醒模型
 */
export function injectVerificationReminder(
  results: VerificationResult[],
): string {
  const failedDimensions = results.filter((r) => !r.passed)

  if (failedDimensions.length === 0) {
    return ""
  }

  const findings = failedDimensions
    .map((r) => {
      const items = r.findings.map((f) => `  - ${f}`).join("\n")
      return `### ${r.dimension} (${r.severity})\n${items}`
    })
    .join("\n\n")

  return `<system-reminder>
An adversarial review found issues that need to be addressed:

${findings}

You MUST fix these issues before claiming the task is complete.
After fixing, run verification again to confirm all issues are resolved.
</system-reminder>`
}
