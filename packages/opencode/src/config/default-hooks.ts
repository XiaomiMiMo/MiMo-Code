/**
 * 默认 Hook 配置
 *
 * 使用外部脚本实现动态输出，每次注入的内容基于实际状态。
 * 脚本位于 src/config/hooks/ 目录下。
 */

import path from "path"

const hooksDir = path.join(import.meta.dir, "hooks")

/**
 * 默认 hooks 配置
 * 使用外部脚本，每次输出不同
 */
export const DEFAULT_HOOKS: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command?: string; prompt?: string; timeout?: number }> }>> = {
  // 会话开始时：分析项目结构，建议相关命令
  SessionStart: [
    {
      hooks: [
        {
          type: "command",
          command: `bash ${path.join(hooksDir, "session-start.sh")}`,
          timeout: 10,
        },
      ],
    },
  ],

  // 工具执行后：代码修改后分析变更，建议具体验证命令
  PostToolUse: [
    {
      matcher: "edit|write",
      hooks: [
        {
          type: "command",
          command: `bash ${path.join(hooksDir, "post-tool-use.sh")}`,
          timeout: 10,
        },
      ],
    },
  ],

  // 模型停止前：检查未提交变更和测试状态
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: `bash ${path.join(hooksDir, "stop.sh")}`,
          timeout: 10,
        },
      ],
    },
  ],
}

/**
 * 合并用户配置的 hooks 与默认 hooks
 * 用户 hooks 追加到默认 hooks 之后（同一事件）
 */
export function mergeHooks(
  userHooks: Record<string, any[]> | undefined,
  defaultHooks: Record<string, any[]> = DEFAULT_HOOKS,
): Record<string, any[]> {
  if (!userHooks) return defaultHooks

  const merged: Record<string, any[]> = { ...defaultHooks }

  for (const [event, hooks] of Object.entries(userHooks)) {
    if (merged[event]) {
      merged[event] = [...merged[event], ...hooks]
    } else {
      merged[event] = hooks
    }
  }

  return merged
}
