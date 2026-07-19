# MiMo Orchestrator Mode

**一句话总结**：一个"调度者"主模式——用**单一窗口、单一会话、纯自然语言**管理所有任务：把工作委派给子会话（child session），自己负责协调、集成与汇报，让你不必在多个窗口/会话间来回切换（实验功能，默认关闭）。

## 1. 背景与目标

当你要同时推进多件工作时，常见做法是开好几个终端窗口、每个跑一个编码会话，然后不停地在它们之间切来切去：盯哪个跑完了、哪个卡在等审批、哪个该给下一步指令。真正的负担不是机器算力，而是**你的注意力和精力**——上下文在窗口之间反复切换，人被"多路复用"拖垮。

Orchestrator 模式要解决的正是这个问题：**让你只用一个窗口、一个会话，用纯自然语言就能管理全部任务**。你把目标用自然语言交给 Orchestrator，它替你把活拆开、派发、盯进度、需要你拍板时来找你、完成后汇总——你始终待在同一个对话里，不再在多个窗口间跳转。

为此，Orchestrator 扮演一个"**leader / manager**"角色：

- 把你的目标**拆分成可交付的工作单元**（decomposition），
- 为每个单元**派发一个子会话**（child session，跑在自己的 mode、model、任务面板与记忆里），
- 然后**协调、集成（git 合并）、汇报**。

普通编码模式（build / plan / compose）是"执行者"：一个会话在一个目录里，自己读写代码、跑命令——要并行推进多件事，你就得开多个窗口。Orchestrator 是"管理者"：并行的多个子会话在后台跑，而你面对的始终是**这一个**协调会话。

**核心边界**：Orchestrator 自己**不做实质工作**——不写代码、不做具体实现规划、不做质量评审。这些都委派出去：需要规划的单元派 `plan`（或 `compose`，其工作流内含 plan/review 阶段）；写代码派 `build`。"拆分成派发单元"是它的活；"某个单元怎么实现"和"评审结果"是它委派的活。

**默认关闭**：整套能力由单一 flag `MIMOCODE_EXPERIMENTAL_ORCHESTRATOR` 门控（见第 6 章）。关闭时 MiMoCode 与从前完全一致——没有 Orchestrator 模式、没有 `session` 工具、没有审批路由、没有工作区切换。

## 2. 整体模型

```
用户目标
   │  拆分（decomposition）
   ▼
Orchestrator 会话（全局唯一，见 §5）
   │  session create ──► child A (build,  dir=repo1, --isolate)  ┐
   │  session create ──► child B (plan,   dir=repo2)             │  后台并行
   │  session create ──► child C (compose,dir=repo1, --isolate)  ┘
   │
   │  子会话完成 → actor_notification 回到 inbox → 唤醒 Orchestrator
   ▼
协调 / 集成（git merge 各 child 的 mimocode/* 分支）/ 汇报给用户
```

- 每个 child 是一个**独立会话**（有自己的 session id、任务面板、记忆），以 `mode: "peer"` 在**后台**运行。
- Orchestrator 派发后**立即返回**，不轮询；child 完成时通过 inbox 通知**主动唤醒**它。
- child 是 peer，不是 in-session 的 subagent —— 用户可以像 `mimo -c <id>` 一样**完整 attach** 进任意 child 会话查看/接管。

## 3. `session` 工具（Orchestrator 的核心能力）

只有 Orchestrator 模式能看到并调用 `session` 工具（按 agent 名门控 + flag 门控）。它同时提供 JSON 与 shell 两种调用形态（由工具描述给出具体语法）。共 8 个 verb：

| verb | 作用 | 关键参数 |
|---|---|---|
| `create` | 后台派发一个新的子会话 | `task`（首轮任务，必填）；可选 `mode`（build\|plan\|compose，默认 build）、`model`、`title`、`dir`（child 运行的目录，任意项目/路径，默认 Orchestrator 自己的目录）、`isolate`（在 `dir` 的仓库里开一个独立 git worktree 跑，避免并发写冲突） |
| `switch` | 把前端面板切到某个会话 | `sessionID`（先 `list` 把自然语言解析成 id，再 switch） |
| `list` | 列出本 Orchestrator 的所有子会话（id / title / mode / status） | — |
| `cancel` | 停止一个不再需要的子会话；若曾 `--isolate` 会一并删除其 worktree 与分支 | `sessionID` |
| `ask` | 对某会话发一次**只读、一次性**的旁路提问（基于其历史的冻结快照回答，不打断它的运行） | `session_id` + `question` |
| `setmode` | 改变一个子会话**后续轮次**运行的 mode（如 plan child 规划完切成 build 在**同一会话**里执行，无需新开会话） | `sessionID` + `mode`（build\|plan\|compose） |
| `approve` | 批准某个子会话**当前挂起**的权限请求（见 §4） | `sessionID` |
| `grant-approval` | 预授权：让未来的权限请求自动批准（免每次询问） | `target`（某 child 的 sessionID，或 `all` 表示所有子会话） |

实现见 `packages/opencode/src/tool/session.ts`（verb 列表 `KNOWN_VERBS`）。

### 3.1 目录与隔离（`--dir` / `--isolate`）

Orchestrator 是**通用**协调者，可跨不同项目干活，所以每个 child 的目录与隔离**按任务逐个决定**，不假设当前项目：

- `dir` —— child 运行的目录。指向任务所属的项目/子项目/临时目录；省略则用 Orchestrator 自己的目录。
- `isolate` —— 打开后，child 在 `dir` 所属仓库里跑在**它自己的 git worktree**（分支 `mimocode/<任务>`），这样多个 child 编辑同一仓库时互不冲突、也不与 Orchestrator 冲突。适合"会改文件、且可能并发"的场景；只读/单写、或非 git 目录则关闭（非 git 时自动降级为直接在 `dir` 里跑）。

worktree 在 `dir` 所属仓库自己的 Instance 上创建/删除（跨项目正确）；child worktree 位于 `<data>/worktree/<projID>/<task-slug>`，分支为 `mimocode/<task-slug>`。

### 3.2 集成与清理

- 一个 isolated child 的提交在它自己的 `mimocode/<...>` 分支上。Orchestrator 自己用 git 集成（它有 `bash`）：`git log <branch>` / `git diff <base>...<branch>` / `git merge-tree` 预览冲突 → `git merge <branch>`（或 cherry-pick）。用 `git worktree list` / `git branch --list 'mimocode/*'` 找 child 分支。
- **只在工作已合并、或任务被放弃后才 `cancel`** 一个 isolated child —— `cancel` 会删 worktree 和分支，对**未合并**的工作执行会永久丢失该工作。不要因为 child "完成了"就 cancel（完成产生的是它分支上待合并的提交）。

### 3.3 生命周期（no-poll / interrupt / resume）

- **不轮询**：`create` 立即返回，child 后台运行，完成时消息进入 inbox 唤醒 Orchestrator。派发后就返回、答复用户或结束本轮，不要循环 `list`/查状态空耗轮次。
- **中断**：中断 Orchestrator **不会**停掉它的 child ——它们继续后台运行并在完成时通知。要停某个 child 用 `session cancel <id>`。整个会话退出时所有 child 随之退出。
- **恢复全部**：`session list` 枚举子会话，对"最后结果不是成功（被取消/失败/从未汇报）或仍有未完成任务"的 child，用 `actor` 的 send 转发一条消息让它继续。没有单独的 resume 命令——用 list + 转发驱动。

## 4. 子会话权限审批路由

**问题**：后台运行的 child 没有直接面对用户的交互面板。默认情况下，一个后台会话碰到"需要询问（ask）"的权限门（如访问工作区外的目录、读 `.env`）会被**直接拒绝**（`interactive:false` → `DeniedError`），用户看不到、也无从批准。

Orchestrator 的 child 有一条通往人的路径——它的父会话与看 TUI 的用户。所以对 **Orchestrator peer child**，权限 `ask` 被**转发审批**而不是静默拒绝：

- **决策**：`decideAskRouting`（`src/agent/config.ts`）三分：系统 agent（checkpoint-writer/dream/distill）→ 仍自动拒绝；**Orchestrator peer**（background + `mode:peer` + 有父会话）→ 转发审批；其他后台（compose 的 subagent 等）→ 仍自动拒绝。
- **谁来批**：转发后的请求可由 (a) **用户直接批**（切进该 child，用普通的按会话权限 UI），或 (b) **Orchestrator 代批**——当它持有匹配的**委派授权**时。
- **委派授权**：
  - `session grant-approval <childSessionID>` —— 预授权某个 child 的未来 ask 自动通过；
  - `session grant-approval all` —— 预授权本 Orchestrator 的**所有** child；
  - `session approve <childSessionID>` —— 一次性批准该 child 当前挂起的那一个请求。
- **去重**：同一个权限请求只有一份。用户直接批（`Permission.reply`）和 Orchestrator 批（`session approve`）都收敛到同一个 Deferred 上，第二次是幂等 no-op；任一方批准后，Orchestrator 那份转发副本自动丢弃——不会重复处理、不会残留过期请求。
- **不会挂死**：转发的 ask 若无人应答，会在 `FORWARD_DENY_TIMEOUT_MS`（5 分钟，`src/permission/index.ts`）后**自动拒绝**，保留了原自动拒绝机制的"永不挂起"保证；abortSignal 仍可随时取消。
- **通知**：产生转发请求时会**唤醒 Orchestrator**（inbox 通知，带 child id 与如何批准）并给用户弹一条 toast；child **完成**时也给用户 toast（不只是通知 Orchestrator）。

## 5. 全局唯一的 Orchestrator 工作区

Orchestrator 模式使用一个**固定的全局工作目录**（`<data>/orchestrator`，`src/global/index.ts` 的 `orchestratorDir()`）：

- 无论从哪个目录启动 MiMoCode，**切到 Orchestrator 模式**都会把 TUI 的工作目录切到这个全局目录，并落到那里**唯一的**根 Orchestrator 会话（find-or-create）。
- 因此不管在哪启动，永远是同一个 Orchestrator 会话——之前建过的 child 会话始终可见、可访问。否则在不同目录启动会得到不同的 Orchestrator 会话，用户就找不到之前创建的子会话了。

切换序列复用 worktree 对话框的模式：`instance.dispose → switchDirectory → sync.bootstrap →` 找到/新建根会话并导航。服务器的目录 cwd 包含性校验对这个 app 自有的全局目录放行（仅在功能开启时）。

## 6. Flag、默认关

单一 flag 门控整套能力，**默认关闭**、显式 opt-in：

```
MIMOCODE_EXPERIMENTAL_ORCHESTRATOR: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_ORCHESTRATOR")
```

- 默认 **OFF**；设 `MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true` 开启（伞形 `MIMOCODE_EXPERIMENTAL=1` 也会一并开启）。
- **两个承重门控**让功能在关闭时彻底消失：
  1. **agent 注册**（`src/agent/agent.ts`）—— orchestrator agent 仅在 flag 开启时以条件展开注册（对齐 `max` 模式的写法）。关闭时它不进 agent 集合，因而不出现在 TUI 模式循环（Tab）、agent 对话框、`defaultAgent`，也无从派发 peer。
  2. **工具注册**（`src/tool/registry.ts`）—— `session` 工具仅在 flag 开启时注册。关闭时任何 agent 都拿不到它。
- **纵深防御**（关闭时本已是死代码，但显式加固）：TUI 的进入-Orchestrator 目录切换 effect 在 flag 关时提前返回；服务器中间件的全局目录例外仅在 flag 开时生效；`decideAskRouting` 收到 `orchestratorEnabled:false` 时 peer 回退为自动拒绝。

Flag 在 import 时求值一次（读 `process.env`）。测试里在 `test/preload.ts` 提前置为 `true`（Orchestrator 测试套件需要功能开启）。

## 7. 快速上手

1. 开启功能：`MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true`（或 `MIMOCODE_EXPERIMENTAL=1`）。
2. 启动 MiMoCode，按 **Tab** 循环到 **Orchestrator** 模式——工作目录会自动切到全局 Orchestrator 工作区，落到唯一的 Orchestrator 会话。
3. 让它派活，例如：*"创建一个 build 模式的子会话，任务是给 repo1 加登录页，目录设为 /path/to/repo1，启用 isolate；再创建一个 compose 子会话去 repo2 设计计费 schema。"*
4. 用 `/sessions`（或让 Orchestrator `session list`）查看带 `↳` 的子会话；选中即可完整 attach 进去查看/接管，用 session-parent 快捷键返回。
5. 子会话完成会唤醒 Orchestrator 并给你 toast；需要审批的操作会转发给你（或按你的 `grant-approval` 授权自动批）。
6. 满意后让 Orchestrator 把各 isolated child 的 `mimocode/*` 分支合并集成。

## 8. 相关源码

| 关注点 | 位置 |
|---|---|
| Orchestrator agent 定义 + flag 门控 | `packages/opencode/src/agent/agent.ts` |
| Orchestrator 系统提示词（委派者身份） | `packages/opencode/src/session/prompt/orchestrator.txt` |
| `session` 工具（8 个 verb） | `packages/opencode/src/tool/session.ts` |
| 工具注册 + flag 门控 | `packages/opencode/src/tool/registry.ts` |
| 权限审批路由决策 | `packages/opencode/src/agent/config.ts`（`decideAskRouting`） |
| 转发/授权 ref + 去重 | `packages/opencode/src/permission/permission-forward-ref.ts`、`src/permission/index.ts` |
| 全局 Orchestrator 工作区 | `packages/opencode/src/global/index.ts`（`orchestratorDir`）、`src/cli/cmd/tui/app.tsx` |
| flag 定义 | `packages/opencode/src/flag/flag.ts`（`MIMOCODE_EXPERIMENTAL_ORCHESTRATOR`） |
