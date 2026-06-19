/**
 * Hook 系统配置
 *
 * 参考 Claude Code 的 hooks 机制，但适配 MiMoCode 的现有架构：
 * - 用户可在 .mimocode/settings.json 中配置 hooks
 * - Hook 在 run loop 的特定生命周期点触发
 * - Hook 可以返回 additionalContext 注入到对话中
 * - Hook 可以阻止/允许/修改工具调用
 */

import { z } from "zod"

/**
 * Hook 事件类型
 */
export const HookEvent = z.enum([
  "SessionStart",        // 会话开始
  "UserPromptSubmit",    // 用户发送消息
  "PreToolUse",          // 工具调用前
  "PostToolUse",         // 工具调用后
  "Stop",                // 模型准备停止时
  "PreCompact",          // 上下文压缩前
  "PostCompact",         // 上下文压缩后
])
export type HookEvent = z.infer<typeof HookEvent>

/**
 * Hook 处理器类型
 */
export const HookHandler = z.object({
  type: z.enum(["command", "prompt", "agent"]),
  command: z.string().optional(),           // command 类型：shell 命令
  prompt: z.string().optional(),            // prompt 类型：评估提示
  timeout: z.number().optional(),           // 超时时间（秒）
})
export type HookHandler = z.infer<typeof HookHandler>

/**
 * 单个 Hook 定义
 */
export const HookDefinition = z.object({
  matcher: z.string().optional(),           // 正则匹配器（工具名、事件类型等）
  hooks: z.array(HookHandler).min(1),      // hook 处理器列表
})
export type HookDefinition = z.infer<typeof HookDefinition>

/**
 * Hook 配置（嵌套在 settings 中）
 */
export const HooksConfig = z.record(
  HookEvent,
  z.array(HookDefinition),
)
export type HooksConfig = z.infer<typeof HooksConfig>

/**
 * Hook 执行结果
 */
export interface HookResult {
  /** 注入到对话中的额外上下文 */
  additionalContext?: string
  /** 是否阻止操作 */
  blocked?: boolean
  /** 阻止原因 */
  blockReason?: string
  /** 修改后的工具输入 */
  updatedInput?: Record<string, unknown>
  /** 修改后的工具输出 */
  updatedOutput?: string
}
