#!/bin/bash
# PostToolUse hook: 代码修改后，分析变更并建议具体的验证命令
# 每次输出不同，基于实际修改的文件和项目配置

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.args.filePath // .args.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# 根据文件扩展名推断验证命令
EXT="${FILE_PATH##*.}"
CWD=$(pwd)

case "$EXT" in
  ts|tsx|js|jsx)
    # 检查项目中可用的验证命令
    if [ -f "package.json" ]; then
      HAS_TYPECHECK=$(grep -q '"typecheck"' package.json 2>/dev/null && echo "yes" || echo "no")
      HAS_LINT=$(grep -q '"lint"' package.json 2>/dev/null && echo "yes" || echo "no")
      HAS_TEST=$(grep -q '"test"' package.json 2>/dev/null && echo "yes" || echo "no")

      CMDS=""
      [ "$HAS_TYPECHECK" = "yes" ] && CMDS="$CMDS npm run typecheck"
      [ "$HAS_LINT" = "yes" ] && CMDS="$CMDS npm run lint"
      [ "$HAS_TEST" = "yes" ] && CMDS="$CMDS npm run test"

      if [ -n "$CMDS" ]; then
        cat << EOF
{
  "additionalContext": "Modified ${FILE_PATH}. Run verification:${CMDS}"
}
EOF
        exit 0
      fi
    fi
    cat << EOF
{
  "additionalContext": "Modified ${FILE_PATH}. Consider running typecheck/lint if available."
}
EOF
    ;;
  py)
    if command -v pytest &>/dev/null; then
      cat << EOF
{
  "additionalContext": "Modified ${FILE_PATH}. Consider running: pytest ${FILE_PATH}"
}
EOF
    elif command -v python3 &>/dev/null; then
      cat << EOF
{
  "additionalContext": "Modified ${FILE_PATH}. Consider running: python3 -m py_compile ${FILE_PATH}"
}
EOF
    fi
    ;;
  go)
    cat << EOF
{
  "additionalContext": "Modified ${FILE_PATH}. Run: go vet ./... && go test ./..."
}
EOF
    ;;
  rs)
    cat << EOF
{
  "additionalContext": "Modified ${FILE_PATH}. Run: cargo check && cargo test"
}
EOF
    ;;
  *)
    cat << EOF
{
  "additionalContext": "Modified ${FILE_PATH}. Verify changes before proceeding."
}
EOF
    ;;
esac
