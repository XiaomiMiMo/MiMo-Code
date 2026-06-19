/**
 * Hook 配置合并
 *
 * 不提供默认 hooks。Hook 系统仅用于用户自定义扩展。
 * 默认行为由 core-behavior.txt（系统 prompt）+ 路径作用域规则 + 记忆系统实现。
 *
 * 与 Claude Code 的设计一致：
 * - 系统 prompt 定义基础行为框架
 * - 路径作用域规则按需加载项目特定指令
 * - 记忆系统跨会话持久化用户偏好
 * - hooks 仅用于用户自定义扩展（可选）
 */

import type { HooksConfig } from "./hooks"

/**
 * 合并用户配置的 hooks
 * 没有默认 hooks，只有用户配置的 hooks
 */
export function mergeHooks(
  userHooks: HooksConfig | undefined,
): Partial<HooksConfig> {
  return userHooks ?? {}
}
