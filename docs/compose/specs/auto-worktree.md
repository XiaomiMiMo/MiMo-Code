---
date: 2026-08-24
topic: auto-worktree
---

# Auto-Worktree: 基于冲突检测的自动工作树隔离

## 1. 问题

当前所有会话共享主工作目录。当多个任务同时运行时，它们在同一 worktree 内切来切去，隔离性缺失，基线不可控。

## 2. 方案概览

大部分情况下用户直接在主 worktree 工作，这是正常行为。只有当多个任务同时竞争同一目录时，才需要创建 worktree 进行隔离。

**核心思路**：在 session 创建时检测冲突，而不是在每次写操作时检测。

```
用户创建新 session
  │
  ├─ 检测: 同目录是否有活跃 session？
  │   ├─ 是 → 冲突，创建 worktree
  │   └─ 否 ↓
  │
  ├─ 检测: 同目录是否有未提交改动（外部 agent）？
  │   ├─ 是 → 冲突，创建 worktree
  │   └─ 否 → 无冲突，正常使用主 worktree
  │
  └─ 创建 session（可能在新 worktree 中）
```

## 3. 关键设计

### 3.1 冲突检测

使用两个信号检测冲突：

**信号 1：内部 agent 活跃度**
- 检查同目录是否有其他活跃的 mimocode session
- 活跃定义：session 最近 5 分钟内有更新
- 实现：查询 `SessionTable` 中同目录的 session，检查 `time_updated`

**信号 2：外部 agent 活动**
- 检查目录是否有未提交的 git 改动
- 这些改动可能来自 Claude Code、Cursor 等外部工具
- 实现：`git status --porcelain` + 检查 `.git/index.lock`

### 3.2 自动创建 worktree

当检测到冲突时，自动创建 worktree：

- 使用 `Worktree.Service.create()` 创建 worktree
- worktree 路径：`<data>/worktree/<project-id>/<name>`
- 分支命名：`mimocode/<slug>`
- 新 session 的 directory 指向 worktree

### 3.3 复用 Worktree.Service

mimocode 已有完整的 worktree 基础设施：

- `Worktree.Service.create()` — 创建 worktree（自动命名、分支创建、bootstrap）
- `Worktree.Service.makeWorktreeInfo()` — 生成 worktree 信息（不含副作用）
- `isIsolatedWorktree()` — 判定目录是否为 app 管理的 worktree
- 分支命名约定：`mimocode/<slug>`
- 存储路径：`<data>/worktree/<project-id>/<name>`

## 4. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/tool/conflict-detection.ts` | **新建**：冲突检测逻辑（内部 session + 外部 git 状态） |
| `src/server/routes/instance/session.ts` | Session 创建路由：冲突检测 + 自动创建 worktree |
| `src/server/routes/instance/experimental.ts` | 新增 `POST /worktree/auto` 端点 |
| `src/session/session.ts` | CreateInput 新增 `directory` 字段 |

## 5. 不做的事

- **不 hook 写操作**：只在 session 创建时检测冲突，不干扰正常写入流程。
- **不强制创建 worktree**：只有检测到冲突时才创建，单任务正常使用主 worktree。
- **不阻断用户操作**：冲突检测是透明的，用户无感知。

## 6. 与 Desktop 的关系

Desktop 端需要配合的改动（在 mimo-desktop 仓库）：

1. **修正「创建并检出新分支」的默认基线**：从当前 HEAD 改为 main（`git checkout -b <name> main`）
2. **分支 chip 展示**：当 AI 在 linked worktree 中工作时，chip 应显示该 worktree 的分支
3. **设置页工作树区段**：已有 `worktreesList` 枚举，无需改动

## 7. 待定

- 活跃 session 的判定阈值（当前 5 分钟）是否合适？
- 是否需要更精确的外部 agent 检测（进程检测等）？
- worktree 创建失败时的降级策略？
