#!/bin/bash
# SessionStart hook: 分析项目结构，建议相关命令
# 每次输出不同，基于实际的项目配置

INPUT=$(cat)
CWD=$(pwd)

# 检测项目类型和可用命令
COMMANDS=""

# Node.js 项目
if [ -f "package.json" ]; then
  if grep -q '"dev"' package.json 2>/dev/null; then
    COMMANDS="$COMMANDS\n- npm run dev (start development)"
  fi
  if grep -q '"build"' package.json 2>/dev/null; then
    COMMANDS="$COMMANDS\n- npm run build (build project)"
  fi
  if grep -q '"test"' package.json 2>/dev/null; then
    COMMANDS="$COMMANDS\n- npm run test (run tests)"
  fi
  if grep -q '"lint"' package.json 2>/dev/null; then
    COMMANDS="$COMMANDS\n- npm run lint (check code style)"
  fi
  if grep -q '"typecheck"' package.json 2>/dev/null; then
    COMMANDS="$COMMANDS\n- npm run typecheck (type check)"
  fi
fi

# Go 项目
if [ -f "go.mod" ]; then
  COMMANDS="$COMMANDS\n- go build ./... (build)"
  COMMANDS="$COMMANDS\n- go test ./... (test)"
  COMMANDS="$COMMANDS\n- go vet ./... (lint)"
fi

# Rust 项目
if [ -f "Cargo.toml" ]; then
  COMMANDS="$COMMANDS\n- cargo build (build)"
  COMMANDS="$COMMANDS\n- cargo test (test)"
  COMMANDS="$COMMANDS\n- cargo clippy (lint)"
fi

# Python 项目
if [ -f "pyproject.toml" ] || [ -f "setup.py" ]; then
  if command -v pytest &>/dev/null; then
    COMMANDS="$COMMANDS\n- pytest (test)"
  fi
  if command -v ruff &>/dev/null; then
    COMMANDS="$COMMANDS\n- ruff check . (lint)"
  fi
fi

# 构建输出
if [ -n "$COMMANDS" ]; then
  cat << EOF
{
  "additionalContext": "Project detected in ${CWD}. Available commands:${COMMANDS}"
}
EOF
else
  cat << EOF
{
  "additionalContext": "Working in ${CWD}. No standard build tools detected."
}
EOF
fi
