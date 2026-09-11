---
date: 2026-08-24
topic: auto-worktree
---

# Auto-Worktree: 习惯仓硬门 + noHabit 软提醒（模型建树）

## 1. 问题

多个任务共享 git 主 worktree 时会互相踩：基线不可控、并发改同一文件。产品期望是**改完前隔离**，而不是事后收拾。

实测（真模型 one-shot）：仅软提醒不够——模型在「创建文件」类任务里写完 main 就 Done，Notice 落在 user 消息上、无硬后果，无法驱动隔离。

## 2. 当前方案

**不自动建树**。`config.auto_worktree === true` 时：

```
写/edit/apply_patch 或 bash 写/git 变更 目标落在 git MAIN worktree
  │
  ├─ repo 已有 linked worktree（习惯成立）
  │     → 硬门：工具直接报错，禁止写入
  │        恢复步骤写在错误里（git worktree add → 改写新路径）
  │        不自动建树，由模型自己建
  │
  └─ 尚无 linked worktree（noHabit）
        → 允许写入；成功后注入一次 Auto-Worktree Notice
          文案要求模型自选：可建树 / 可问用户 / 可留 main，禁止无视
```

`config.auto_worktree` 默认 false（CLI 默认关）。Desktop 经 `MIMOCODE_CONFIG_CONTENT` 强制 true（见 engine-runtime R8）。

### 2.1 为什么硬门

- 软提醒无强制力：one-shot 任务在 Notice 注入后无后续步骤可执行
- 工具失败是唯一有强制恢复路径的后果
- 习惯仓（已有 worktree）产品语义是 MUST isolate；noHabit 保留模型选择

## 3. 关键设计

### 3.1 硬门（习惯仓）

- 入口：写工具经 **`assertWriteAllowed`**（与 external_directory / memory 同口）；bash 在 ask 前经 `assertHabitRepoMainWriteBlocked`（`mainWorktreeHits`）
- 挂在 write / edit / apply_patch（含 move 目标）/ notebook_edit；multiedit 走 edit
- 路径判定与 Notice 共用 `walkGitLayout` / `findGitMainWorktree` / `repoHasLinkedWorktrees`
- **child 判据**：`actorID` 非 `main`（对齐 `task.ts`），或 `agentMode === "subagent"`；自定义 agent 默认 `mode: "all"` 但以 actor 身份运行时仍是 child
- Config 经 `Effect.serviceOption` 读取；**缺失 fail-open**
- 生产：`AppRuntime.mergeAll` 含 `Config`
- 测试：外层 fiber `Effect.provide(Config.defaultLayer)`，否则硬门假绿

**bash 穿孔（诚实边界）**：门只认 `mainWorktreeHits` 静态 AST。含 `$` 的 redirect、`node -e` / `python -c` 一类解释器写盘**不在 hits 内**——write/edit 是真硬门，bash 是 best-effort 子集，不是完备不可绕过。

### 3.2 软提醒（noHabit）

- 注入点：`SessionPrompt.insertReminders`，首次**成功**写/git 变更落到 MAIN 后
- 骑在最近一条 user 消息（synthetic part），不进 system prompt
- 去重：`session.auto_worktree_hint_sent`
- 习惯仓成功写入路径在硬门生效时不可达；`buildAutoWorktreeNotice` 的 hasHabit 文案仍保留（多仓 standing rule / 硬门失效时的解释层）

### 3.3 错误文案契约（按角色分叉）

| 角色 | 判据 | 文案 |
|------|------|------|
| parent | `agentMode !== "subagent"` | 说明被拦 + **须隔离到本仓 worktree 后再写**；不写 `git` 菜谱 |
| child | `agentMode === "subagent"` | 禁止自建树；上报 parent，等 parent 给路径再写 |

原则：门只陈述**策略与后果**。具体如何 `git worktree add` 是模型行为，不在工具错误里 micromanage（曾写过 `./.wt-<name>` 菜谱，会掩盖 external_directory 等真问题）。

`AutoWorktreeBlockedError` 必须含 MAIN 路径与 `Do NOT retry against the main worktree path`。Tool 层会抹掉 `Error.name`。

`Tool.Context.agentMode` 由 `SessionPrompt` 从 `input.agent.mode` 注入。

### 3.4 并发 subagent

- Subagent 与 parent **共享 session / Instance.directory**；隔离是 workstream 级决策，必须只由 main agent 做一次。
- 若让每个 subagent 各自 `git worktree add`：并发争用 `.git/worktrees`、撞分支名、留下 parent 不知道的孤儿树。
- 因此 child 门只 escalate，从不给出自建树步骤。
- noHabit 时并发 subagent 仍可同时写 main（产品自选区）——文件级竞态是既有并发编辑问题，不归 auto-worktree 门管。
- parent 先隔离到 linked worktree 后，subagent 写该路径（或父给的绝对路径）因 `isMain=false` 放行。

### 3.5 不做的事

- **不自动创建 worktree**（`POST /experimental/worktree/auto` 已删除）
- **不弹权限卡**
- **不在 TUI UI 展示** synthetic reminder
- noHabit 不硬拦（产品自选）

## 4. 涉及文件

| 文件 | 角色 |
|------|------|
| `src/tool/auto-worktree-hint.ts` | 布局判定、硬门、Notice 文案 |
| `src/tool/write.ts` / `edit.ts` / `apply_patch.ts` / `notebook-edit.ts` | 写工具硬门 |
| `src/tool/bash.ts` | bash 变更硬门（ask 前） |
| `src/session/prompt.ts` `insertReminders` | noHabit Notice 注入 |
| `src/config/config.ts` | `auto_worktree` 开关（默认 false） |
| `src/session/session.sql.ts` | `auto_worktree_hint_sent` |

## 5. 测试

| 层 | 测什么 | 落点 |
|----|--------|------|
| unit | 习惯/开关/linked/非 git 矩阵；错误文案 | `test/tool/auto-worktree-write-gate.test.ts` |
| session | 习惯仓 write/bash 被拦；noHabit Notice；config 关不拦 | `test/session/auto-worktree-notice.test.ts` |
| session e2e | 写 main 失败 → 建树 → 写入隔离区 | `test/session/auto-worktree-isolate-e2e.test.ts` |
| Desktop | 强制 `auto_worktree: true` 后同引擎硬门 | `mimo-desktop` R8 |

TUI 与 Desktop 共用引擎工具层；TUI 默认不渲染 synthetic part。
