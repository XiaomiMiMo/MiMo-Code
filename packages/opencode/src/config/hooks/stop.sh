#!/bin/bash
# Stop hook: 模型停止前，检查是否有未完成的工作
# 每次输出不同，基于实际的 git 状态和任务状态

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.sessionID // empty')

# 检查 git 状态
GIT_STATUS=""
if command -v git &>/dev/null && git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  CHANGED=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$CHANGED" -gt 0 ]; then
    GIT_STATUS="You have ${CHANGED} uncommitted file(s). "
  fi
fi

# 检查是否有测试失败（快速检查）
TEST_STATUS=""
if [ -f "package.json" ] && grep -q '"test"' package.json 2>/dev/null; then
  # 只检查最近修改的文件是否有对应的测试
  MODIFIED_TS=$(git diff --name-only 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$' | head -5)
  if [ -n "$MODIFIED_TS" ]; then
    TEST_STATUS="Modified source files detected. Consider running tests. "
  fi
fi

# 组装输出
if [ -n "$GIT_STATUS" ] || [ -n "$TEST_STATUS" ]; then
  cat << EOF
{
  "additionalContext": "${GIT_STATUS}${TEST_STATUS}Before stopping, ensure all tasks are complete and changes are verified."
}
EOF
else
  cat << EOF
{
  "additionalContext": "Before stopping: verify all tasks are marked done, all code changes are tested, and the user's request is fully addressed."
}
EOF
fi
