/**
 * protocol-level.ts — 强制流程协议级别管理
 *
 * 根据当前任务上下文自动检测合适的协议级别：
 *   minimal  → 简单任务：跳过大部分门控和提醒
 *   standard → 普通任务：标准流程（默认）
 *   enhanced → 复杂任务：全量门控和详细协议
 *
 * 这是"强制流程软化"策略的核心部件。
 */

export type ProtocolLevel = "minimal" | "standard" | "enhanced"

/** 检测协议级别的上下文参数 */
export interface ProtocolContext {
  userText: string
  agentName: string
  msgCount: number
}

const COMPLEXITY_KEYWORDS = [
  "architect", "design", "migrate", "refactor",
  "multi-file", "cross-module", "integration",
  "performance", "security", "distributed",
  "复杂", "架构", "设计", "迁移",
  "重构", "模块", "集成",
]

/**
 * 检测当前轮的协议级别。
 *
 * 规则：
 * - plan/compose agent → 至少 standard
 * - 短消息（< 30 字符）→ minimal
 * - 含复杂关键词 → enhanced
 * - 消息数 > 20 → enhanced
 * - 其他 → standard
 */
export function detectProtocolLevel(ctx: ProtocolContext): ProtocolLevel {
  const { userText, agentName, msgCount } = ctx
  if (!userText) return "standard"

  const text = userText.toLowerCase().trim()

  // 特定 agent 需要标准以上协议
  if (agentName === "plan") return "standard"
  if (agentName === "compose") return "standard"

  // 长对话 → 增强协议
  if (msgCount > 20) return "enhanced"

  // 含复杂关键词 → 增强
  if (COMPLEXITY_KEYWORDS.some((k) => text.includes(k))) return "enhanced"

  // 短消息或匹配简单模式 → minimal
  if (text.length < 30) return "minimal"

  return "standard"
}
