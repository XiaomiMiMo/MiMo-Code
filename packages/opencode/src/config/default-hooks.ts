/**
 * 默认 Hook 配置
 *
 * 当用户没有在 .mimocode/settings.json 中配置 hooks 时，
 * 使用这些默认行为。用户配置的 hooks 会与默认 hooks 合并。
 *
 * 设计哲学：
 * - 默认 hooks 复制当前硬编码的 system-reminder 行为
 * - 用户可以通过配置覆盖或扩展默认行为
 * - 合并策略：用户 hooks 追加到默认 hooks 之后
 */

/**
 * 默认 hooks 配置
 * 与 prompt.ts 中硬编码的 system-reminder 行为一致
 */
export const DEFAULT_HOOKS: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command?: string; prompt?: string; timeout?: number }> }>> = {
  // 会话开始时：注入推荐的工作方式
  SessionStart: [
    {
      hooks: [
        {
          type: "command",
          command: `cat << 'HOOK_EOF'
{
  "additionalContext": "Recommended approach for this session:\\n1. Use task tool to break complex work into subtasks.\\n2. Delegate code exploration to actor(subagent_type='explore').\\n3. For complex tasks (3+ files), consider plan mode first.\\n4. After code changes, always run verification (typecheck/lint/test)."
}
HOOK_EOF`,
        },
      ],
    },
  ],

  // 工具执行后：代码修改后建议验证
  PostToolUse: [
    {
      matcher: "edit|write",
      hooks: [
        {
          type: "command",
          command: `cat << 'HOOK_EOF'
{
  "additionalContext": "Code modified. Run verification (typecheck/lint/test) before claiming the task is complete."
}
HOOK_EOF`,
        },
      ],
    },
  ],

  // 模型停止前：确保任务完成
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: `cat << 'HOOK_EOF'
{
  "additionalContext": "Before stopping: verify all tasks are marked done, all code changes are tested, and the user's request is fully addressed."
}
HOOK_EOF`,
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
