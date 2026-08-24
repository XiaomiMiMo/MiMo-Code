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
  ├─ 信号 1: 同目录是否有活跃 session？
  │   └─ 是 → 冲突
  │
  ├─ 信号 2: 同目录是否有 git lock？
  │   └─ 是 → 冲突
  │
  ├─ 信号 3: 同目录是否有外部 agent 进程？
  │   └─ 是 → 冲突
  │
  ├─ 有冲突 → 自动创建 worktree
  └─ 无冲突 → 正常使用主 worktree
```

## 3. 关键设计

### 3.1 冲突检测（3 信号组合方案）

使用 3 个信号检测冲突，任一信号触发即判定为冲突：

**信号 1：内部 agent 活跃度**
- 检查同目录是否有其他活跃的 mimocode session
- 活跃定义：session 最近 5 分钟内有更新
- 实现：查询 `SessionTable` 中同目录的 session，检查 `time_updated`

**信号 2：Git lock 文件**
- 检查 `.git/index.lock` 是否存在
- 表示有 git 操作正在进行中
- 实现：`fs.existsSync(path.join(gitDir, "index.lock"))`

**信号 3：外部 agent 进程**
- 检查已知 AI 编码工具的进程是否在运行
- 覆盖：Claude Code、Kilo Code、Codex、Cursor（匹配 ps -o comm= 真实命令名）
- 已排除：Cline（VSCode 扩展，无独立进程）、omp/pi（无已知 CLI 二进制）
- 实现：`lsof -t +D <directory>` + `ps -p <pid> -o comm=`（Linux/macOS）；`wmic`（Windows）

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
| `src/tool/conflict-detection.ts` | **新建**：3 信号冲突检测逻辑 |
| `src/tool/auto-worktree-hint.ts` | **新建**：hint 注入逻辑 |
| `src/tool/write.ts` | WriteTool 注入 hint |
| `src/tool/edit.ts` | EditTool 注入 hint |
| `src/tool/apply_patch.ts` | ApplyPatchTool 注入 hint |
| `src/server/routes/instance/session.ts` | Session 创建时检测冲突 |
| `src/server/routes/instance/experimental.ts` | 新增 `POST /worktree/auto` 端点 |

## 5. 不做的事

- **不 hook 写操作**：只在 session 创建时检测冲突，不干扰正常写入流程。
- **不强制创建 worktree**：只有检测到冲突时才创建，单任务正常使用主 worktree。
- **不阻断用户操作**：冲突检测是透明的，用户无感知。

## 6. 待定

- 活跃 session 的判定阈值（当前 5 分钟）是否合适？
- 外部进程检测的误报率如何？是否需要更精确的 cwd 匹配？
- worktree 创建失败时的降级策略？
