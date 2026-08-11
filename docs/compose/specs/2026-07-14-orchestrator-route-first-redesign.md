---
date: 2026-07-14
topic: orchestrator-route-first-redesign
revisions:
  - date: 2026-07-15
    change: "AI-route revision: removed tool-level matching (findBestMatch/heuristic/embedding). Route decision is entirely AI-side — harness injects <active-sessions>, prompt guides AI to route-first, AI uses existing session send/create directly. No new route tool operation."
  - date: 2026-07-17
    change: "User's Agent upgrade: reframed Orchestrator from message-router to user's proxy/agent. Added 3 active-decision duties (permission decisions, answer child questions, proactive audit) mapped to existing session-tool primitives. Route-first becomes the dispatch sub-part of the larger agent identity."
---

# Orchestrator Redesign: The User's Agent

## Problem Frame

The MiMoCode Orchestrator (`src/agent/agent.ts:231`, gated by `MIMOCODE_EXPERIMENTAL_ORCHESTRATOR`) is an experimental persistent coordinator that delegates work to background child sessions via the `session` tool. Its current architecture suffers from a **create-first default** that causes session explosion.

### Symptom: Session Explosion

In practice, the Orchestrator面对同一条主题的反复工作请求时, 每次都倾向于 `session create` 新建子会话, 而不是复用已有的。一个典型场景:

1. 用户说 "fix the login bug" → Orchestrator creates child A for "fix login bug"
2. 用户说 "also handle the signup flow" → Orchestrator creates child B (could have been routed to A)
3. 用户 says "one more thing about auth" → Orchestrator creates child C (again, A or B could handle this)

结果: 三个子会话做本质上同主题的工作, 每个都有独立的上下文和内存, 没有共享任何进展。

### Root Cause: create 耦合了路由和创建

当前 `session create` 命令同时承担两个职责:
- **路由决策**: 这条任务该交给哪个已存在的会话?
- **创建行为**: 如果没有合适的, 新建一个

`--topic` 机制是对此的修补 — 它在 create 内部加了一层 find-or-reuse, 但:
1. **topic 字符串匹配不可靠**: LLM 传什么 topic 取决于 prompt engineering, 语义漂移是必然的 (PR #1727 去掉了严格 topic 字符串匹配, 是止血不是根本解)
2. **topic 必填只保证"有值"不保证"语义正确"**: Orchestrator 可以给同一个主题传不同的 topic 值, 匹配就失效了
3. **复用 ≠ 给 create 找一个 key**: 真正的复用是"从现有会话里选一个最合适的发过去", 不是"给新会话打个标签以便下次匹配"

### Why Topic Matching Cannot Work (Any Variant)

| Variant | Why It Fails |
|---------|-------------|
| Exact string match | LLM 不可能每次都传完全相同的字符串 |
| Fuzzy / semantic match | 需要 embedding 或 LLM 判断, 增加延迟和复杂度, 且仍然依赖 LLM 正确提取"主题" |
| Topic 必填 | 保证有值, 不保证语义正确; LLM 会乱传 |
| Task-ID 绑定 | task 是廉价的, 一个 session 本该服务多个 task; task↔session 非一一对应 |
| Topic hierarchy | 过度工程; 真正需要的只是"看一眼活会话列表, 选一个发过去" |

**核心洞察**: 所有 topic 变体都错在同一个假设 — 把复用当成"给 create 找一个 key"。但真正的复用模式是 **人看聊天列表选一个发消息** — 你不会给每个聊天窗口打标签然后按标签匹配, 你看一眼列表就知道该发给谁。

### Why Tool-Level Matching Also Cannot Work

初版设计曾提出 `session route` 操作, 内置 `findBestMatch` (启发式/embedding/LLM-assisted) 做自动匹配。这也是错的:

- **Orchestrator 本身就是 AI** — 它能理解语义、判断相关性、权衡上下文。让工具层用机械匹配替代 AI 的语义判断, 是倒退。
- **匹配逻辑无法覆盖所有场景**: "这个任务该交给谁" 取决于任务内容、会话历史、用户意图、依赖关系 — 这些是 AI 的强项, 不是算法的强项。
- **增加一层抽象但没有增加能力**: 工具层匹配只是把 AI 的路由决策权抢走, 然后用一个更差的决策替代。

**正确分工**: 工具层提供 **信息** (活会话清单) 和 **执行** (send/create), AI 做 **决策** (路由到谁)。

## First-Principles Analysis

### Orchestrator 的本质: 用户的代理人

Orchestrator 不是 "decompose → dispatch (create)" 模型, 也不仅仅是一个传声筒/路由器。它的本质是:

> **站在用户的角度, 代替用户做决策**

它不是被动地把消息从 A 搬到 B。它是用户的 **代理人 (agent/proxy)** — 理解用户的意图, 在用户的名义下做判断、做决定、把关质量。Route-first (该发给哪个会话) 只是它的一项职能 — **dispatch (派发)** — 而不是它的全部身份。

Orchestrator 作为用户代理人的三项核心职责:

| 职责 | 含义 | 对应的用户行为 |
|------|------|---------------|
| **Dispatch (派发)** | 决定任务交给哪个已有会话, 或是否需要新建 | 用户看聊天列表选一个发消息 |
| **Act for user (代用户决策)** | 代替用户批准权限请求、回答子会话的问题 | 用户看到权限弹窗点击批准; 用户看到子会话提问直接回答 |
| **Audit quality (把关质量)** | 主动检查子会话是否真正完成且质量达标, 而非被动等待汇报 | 用户审查交付物, 不盲目相信"做完了" |

这三项职责不是独立的功能列表, 而是 **同一个代理身份的不同表达**:
- Dispatch 是 **入口**: 把工作送到对的地方
- Act-for-user 是 **运行中**: 子会话需要用户介入时, 代理人代为决策
- Audit quality 是 **出口**: 子会话说"做完了"时, 代理人验证是否真的做完了

这个身份不与 route-first 矛盾 — route-first 是 dispatch 的机制; proactive audit 是 quality-gate 的机制; acting-for-the-user 是底层的 agent 本质。三者共同构成 "用户的代理人" 完整身份。

决策的输入是:
- 活会话清单 (谁在线, 在做什么, 做到哪了)
- 当前任务的语义
- 子会话的请求 (权限、问题、完成通知)
- 用户的意图和偏好

决策的输出是:
- route-to-existing: 把任务发给某个已有会话 (`session send`)
- create-as-fallback: 清单里没合适的 → 新建一个, 加入清单
- approve/answer: 代替用户批准权限、回答子会话问题
- audit: 验证子会话的交付质量

### 当前模型 vs 目标模型

```
Current:  user task → decompose → create (default) → (maybe topic reuse)
                                    ↑ create 是一等操作; 被动等通知; 盲目转发权限

Target:   user task → Orchestrator (as user's agent):
              ├─ Dispatch: read <active-sessions> → send or create (route-first)
              ├─ Act for user: decide permission asks, answer child questions
              └─ Audit quality: verify completion before declaring done
                                    ↑ 主动代理, 不是被动传声筒
```

### 类比: 人如何管理多会话

一个人面对多个聊天窗口时:
1. 看一眼所有活跃窗口 (自动注入的清单)
2. 根据消息内容判断该发给谁 (AI 的语义判断)
3. 如果没有合适的窗口, 新开一个 (create as fallback)

人不会: 收到消息 → 新建窗口 → 给窗口打标签 → 期望下次能按标签找到。
人也不会: 收到消息 → 让算法自动匹配 → 发给匹配结果。

人会: 看一眼列表, 自己决定发给谁。

## Target Design

### Core Principle: Orchestrator is the User's Agent

整个设计的核心原则:

> **Orchestrator 是用户的代理人。它不是传声筒, 而是在用户的名义下主动做决策 — 派发工作、代用户回答和批准、把关交付质量。工具层提供信息和执行, AI 做所有决策。**

具体来说:
- **Dispatch (派发)**: AI 看 `<active-sessions>` 清单, 决定 send 给谁或 create 新会话。没有 `findBestMatch`, 没有启发式 — AI 是最好的路由器。
- **Act for user (代用户决策)**: 子会话的权限请求和提问, Orchestrator 代替用户判断和回答, 而非盲目转发。
- **Audit quality (把关质量)**: 子会话报告完成时, Orchestrator 主动验证交付质量, 而非被动接受。

这意味着:
- **不需要新的 tool verb** — 所有操作都映射到现有 session tool primitives
- **不需要工具层的匹配逻辑** — 所有决策完全在 prompt + AI 层
- **最小化代码变更** — 核心变更是 (1) context injection, (2) orchestrator.txt 重写

### R1: Harness 注入活会话清单

Orchestrator 的 system prompt 需要注入 **活会话上下文**, 像人看聊天列表一样:

**注入内容** (每次 Orchestrator turn 开始时, 极简摘要格式):

```xml
<active-sessions>
  ses_abc123 | Fix login bug | build | progressing
  ses_def456 | Design billing schema | compose | idle
  ses_ghi789 | Triage repo issues | build | stalled
</active-sessions>
```

每个会话一行: `id | title | agent | status`。只有 4 个字段, 没有 dir 和最近任务详情。第 3 个字段是子会话的 **agent**(`build`/`plan`/`compose` — 即上面示例里的 `build`/`compose`), **不是**它的 actor `mode`: peer 子会话的 mode 恒为 `peer`, 不携带任何路由信号, 而 agent 才是"这个孩子能做什么"的判断依据。实现见 `packages/opencode/src/session/llm.ts` 里渲染 `actor.agent` 的那一行。AI 需要详情时, 自己调用 `session ask` 或 `session status` 按需查询。详见 R1.1 注入策略。

**注入位置**: `packages/opencode/src/session/llm.ts:240-306` (`buildSystemArray`)。在 agent prompt 组装完成后、plugin transform 前, 注入一个 `<active-sessions>` block。这个 block 由 `session list` 的数据自动生成, 不需要 Orchestrator 主动调用。

**内容来源**:
- `sessions.children(ctx.sessionID)` 获取子会话列表
- `actorReg.get()` 获取 actor 状态 (mode, agent type)
- `deriveLiveness()` 计算进度状态 (progressing/stalled/idle/terminal)
- Terminal 状态 (success/failed/cancelled) 的会话不注入 — 只列活跃会话


### R1.1: `<active-sessions>` Injection Strategy

R1 描述了注入什么, 但没有回答 **怎么注入** — 特别是: 是每轮全量注入, 还是有更聪明的策略? 这个问题在会话数增长后变得关键。

#### 问题: 全量详情注入的代价

如果每轮 turn 都把完整的 `<active-sessions>` (含 dir、最近任务详情等) 注入 system prompt:
- **Context 膨胀**: N 个会话 × 每个 ~100 tokens = N×100 tokens, 每轮重复。20 个会话就是 ~2000 tokens/轮。
- **重复浪费**: 大部分 turn (正和某子会话对话、做非路由工作) 根本不需要全量清单。Orchestrator 和 child A 对话时, B/C/D/E 的详情是噪音。
- **Cache 失效**: prompt cache 依赖 system prompt 前缀稳定; 清单每轮变 (状态/新会话) 导致 cache 频繁失效。

#### 方案对比

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A: 按需拉取** | 不注入, 提供轻量 `session list` 动作让 AI "要路由才查" | 零常驻开销 | 回到靠 LLM 自觉去查 — 用户已批评过依赖自觉; AI 可能忘记查就直接 create |
| **B: 全量详情注入** | 每轮注入完整清单 (id/title/mode/status/dir/最近任务) | AI 始终有完整信息 | Context 膨胀; 大部分 turn 浪费; cache 失效 |
| **C: 极简摘要注入** | 每轮注入极简清单 (id/title/mode/status, 一行一会话, 无 dir/详情) | 低成本 (N 行 ≈ N×30 tokens); AI 有足够信息做路由决策; 需要详情时自己 ask | 信息密度低于 B, 但路由决策通常不需要 dir/详情 |
| **D: 条件注入** | 只在"新工作到达需路由决策"的 turn 注入, 非每轮 | 精准 | 需要判定"何时该注入" — 增加判定逻辑复杂度 |
| **E: 增量注入** | 只注入变化 (新会话/状态变更), 非每轮全量 | 低带宽 | 需要 diff 逻辑; AI 可能丢失已消失会话的信息; 实现复杂 |

#### 推荐: 极简摘要 + 按需详情 (C 为主, A 为辅)

**默认注入极简摘要** (方案 C), AI 需要详情时 **按需查询** (方案 A 作为补充):

```xml
<active-sessions>
  ses_abc123 | Fix login bug | build | progressing
  ses_def456 | Design billing schema | compose | idle
  ses_ghi789 | Triage repo issues | build | stalled
</active-sessions>
```

**为什么这组最优**:

1. **极简摘要足够做路由决策**: 路由只需要 "谁在线、在做什么、什么模式"。id + title + mode + status 四个字段覆盖了 90% 的路由判断。Dir 和最近任务详情是 "确认级" 信息, 不是 "决策级" 信息 — AI 先凭摘要选定目标, 需要确认时再 `session ask` 或 `session status` 查详情。

2. **成本可控**: 一行 ~30 tokens。10 个会话 = ~300 tokens, 20 个会话 = ~600 tokens。相比全量详情 (10 个会话 ~1000 tokens) 小一个数量级。即使 50 个会话也只 ~1500 tokens, 可接受。

3. **天然过滤已归档会话**: 只列非 terminal 状态 (progressing/stalled/idle) 的会话。已 success/failed/cancelled 的会话不注入 — 它们不需要路由, 且会无限膨胀清单。需要查询已归档会话时, AI 自己 `session list` 或 `session ask`。

4. **不依赖 LLM 自觉**: 与方案 A 纯按需不同, 极简摘要是 **默认注入** — AI 每轮 turn 都能看到清单, 不需要记住去查。只是清单是精简版, 不是完整版。

5. **Prompt cache 友好**: 极简摘要变化频率低于全量详情 (status 变化 < 详情变化)。且因为体量小, 即使 cache 失效, 重建成本也低。

**AI 需要详情时的按需路径**:

```
AI 看极简摘要 → 选定目标会话 → 需要确认细节?
  ├─ 不需要 → session send <id> <task>  (直接路由)
  └─ 需要 → session status <id> 或 session ask <id>  (按需查详情)
```

**实现**: `buildActiveSessionsContext` 函数输出极简格式 (一行一会话, 只含 id/title/mode/status), 过滤 terminal 状态。注入位置不变 (`buildSystemArray`, orchestrator agent 类型)。


### R2: orchestrator.txt 决策指引重写

orchestrator.txt 的核心变化 — 让 AI 自己做路由决策:

| Section | Before | After |
|---------|--------|-------|
| 核心循环 | decompose → dispatch (create) | understand → **route** (AI reads list, decides send or create) → yield → integrate → report |
| session tool 参考 | create 是主要操作; approve/grant-approval 未使用 | **send 是主要操作**, create 是 fallback; **approve/grant-approval 代用户决策** |
| 复用指引 | "reuse a standing session per theme" via topic | "see `<active-sessions>` in your context — pick the best match and `session send`" |
| 新增 Duties | — | Route Decision (dispatch); Permission Decision (act-for-user); Answer Questions (act-for-user); Audit Completion (quality gate) |

**orchestrator.txt 新增 Route Decision section 的内容指引**:

```
## Routing: route to existing sessions first

Your system prompt contains an <active-sessions> block listing your routable
child sessions in compact format: id | title | agent | status.
This is your fleet — use it.

When a new task arrives, your FIRST action is to decide: does an existing session
already own this work? Look at <active-sessions> and evaluate:
- Which session's title/theme matches this task's domain?
- Which session's agent (build/plan/compose) is appropriate?
- Is the session idle (ready for new work) or progressing (can accept follow-up)?

If you need more detail about a session (its directory, recent commits, etc.),
use `session status <id>` or `session ask <id>` — the compact list gives you
enough to route; details are on-demand.

If you find a good match → `session send <id> <task>` (route to existing).
If no session fits → `session create <task>` (create as fallback).

DO NOT create a new session when an existing one can handle the work.
One session serving multiple related tasks is the norm, not the exception.
```

### R3: create 降级为 fallback

`session create` 保留但语义变化:

- **之前**: create 是默认操作, Orchestrator 的第一反应
- **之后**: create 是 "AI 判断没有合适会话时的 fallback"
- `--topic` 机制保留但降级为可选的 hint, 不再是路由的核心

Orchestrator 的决策流程变为:

```
1. 收到用户任务
2. 看 <active-sessions> (自动注入, 不需要 list 调用)
3. AI 判断: 有没有一个现有会话适合处理这个任务?
   ├─ Yes → session send <sessionID> <task>  (AI 自己选 ID)
   └─ No  → session create <task>            (AI 自己决定参数)
4. 返回结果给用户
```



## Orchestrator as the User's Agent/Proxy

前文的 route-first + `<active-sessions>` injection 覆盖了 **dispatch (派发)** 职责 — 这是 Orchestrator 的入口。但一个真正的用户代理人还需要在 **运行中** 和 **出口** 做决策。本节将 Orchestrator 的完整代理身份映射到现有 session-tool primitives。

### Duty 1: Permission Decisions — 代替用户批准

**场景**: 子会话运行中碰到需要用户授权的权限请求 (访问工作区外目录、读 `.env` 等)。当前行为是盲目转发给用户, 用户需要切进子会话面板手动批准。

**代理人行为**: Orchestrator **代替用户判断**这个权限请求是否合理, 在自己的上下文中批准或拒绝, 而非每次都转发给用户。

**映射到现有 primitives**:

| Primitive | 作用 | 代理人用法 |
|-----------|------|-----------|
| `session approve <id>` | 批准某子会话当前挂起的一个权限请求 | Orchestrator 收到转发的权限请求后, 判断是否合理 → 合理则 `session approve`; 不合理则拒绝 |
| `session grant-approval <id>` / `session grant-approval all` | 预授权: 未来权限请求自动批准 | 对已建立信任的子会话, 预授权免每次判断 |
| `decideAskRouting` (config.ts) | 决定权限请求转发给谁 | 现有逻辑: Orchestrator peer → 转发给 Orchestrator。**不变** — 转发机制已有, 改变的是 Orchestrator 收到后的处理方式 |

**orchestrator.txt 指引**:

```
## Permission decisions — act on the user's behalf

When a child session sends you a permission request (forwarded ask), you are
the user's proxy. DO NOT blindly relay every permission prompt to the user —
that would make you a mere message relay, not an agent.

Instead, judge the request yourself:
- Is this permission reasonable for the child's stated task? → APPROVE it.
- Is this suspicious or outside the child's scope? → DENY it.
- Is this genuinely uncertain or irreversible? → THEN relay to the user.

Use `session approve <id>` for one-time approvals.
Use `session grant-approval <id>` when you trust a child's judgment for its
entire task scope (e.g. a build child that needs file access across its directory).
Only escalate to the user for genuinely ambiguous or high-stakes decisions.
```

### Duty 2: Respond to Child Questions — 代替用户回答

**场景**: 子会话在运行中遇到需要用户输入的问题 (选哪个方案? 确认需求? 提供缺失信息?)。当前行为是把问题转发给用户。

**代理人行为**: Orchestrator **利用自己对用户意图的理解**直接回答子会话的问题, 而非每次都转发。只有真正需要用户亲自判断时才转发。

**映射到现有 primitives**:

| Primitive | 作用 | 代理人用法 |
|-----------|------|-----------|
| `session send <id> <message>` | 向子会话发送消息 (唤醒或追加) | Orchestrator 直接 send 回答给子会话, 代替用户回复 |
| `session ask <id> <question>` | 向子会话提只读问题 (不打断其任务) | Orchestrator 可以先 ask 了解子会话的上下文, 再决定如何回答 |
| `actor_notification` (inbox) | 子会话的通知/问题到达 Orchestrator 的 inbox | **不变** — 通知机制已有; 改变的是 Orchestrator 收到后的处理方式: 从 "转发给用户" 变为 "自己回答或有条件转发" |

**orchestrator.txt 指引**:

```
## Answer child questions — you know the user's intent

When a child session asks a question upward, you are the user's proxy.
You know the user's goals, preferences, and constraints from the conversation.
DO NOT blindly relay every child question to the user — answer it yourself
when you can, based on your understanding of the user's intent.

- You know the user wants X? Tell the child to do X. Use `session send`.
- The question is about implementation details you don't know? Let the child
  decide (it has the context). Use `session send` with "use your judgment".
- The question is about an irreversible choice you can't decide? THEN relay
  to the user. But this should be rare.

The user delegated to you because they don't want to be interrupted by every
sub-decision. Be the buffer, not the conduit.
```

### Duty 3: Proactive Audit — 主动把关质量

**场景**: 子会话报告 "任务完成"。当前行为是被动接受通知, 假设子会话说完成就是完成。

**代理人行为**: Orchestrator **主动验证**子会话的交付是否真的完成且质量达标, 而非盲目相信。这是 **fan-in/aggregation** 的质量门: 不是子会话说 done 就 done, 而是代理人审查后确认 done。

**映射到现有 primitives**:

| Primitive | 作用 | 代理人用法 |
|-----------|------|-----------|
| `session join <id...>` | 等待所有子会话到达 terminal 状态, 返回聚合摘要 | 批量派发后的 fan-in 聚合点 — Orchestrator 收到聚合结果后审查 |
| `session status <id>` | 查询子会话的派生 liveness (progressing/stalled/terminal) | 定期或收到通知后, 检查子会话的真实状态 |
| `session ask <id> <question>` | 向子会话提只读问题 (基于其历史回答) | 审查: "你的任务完成了吗? 交付物是什么? 有没有遗漏?" — 基于子会话历史的只读查询 |
| `session dashboard` | 舰队全景 (liveness + worktree 状态) | 宏观审查: 所有子会话的整体进展和健康度 |
| `git log/diff` (via bash) | 审查 isolated 子会话的提交 | 对 isolated child: 直接审查 git commits 的质量, 而非只看子会话的自我报告 |

**orchestrator.txt 指引**:

```
## Audit completion — verify, don't trust

When a child session reports completion, you are the quality gate.
DO NOT blindly accept "I'm done" as final — verify before declaring success.

Verification steps (pick per situation):
1. `session status <id>` — is it truly terminal (not just idle-without-reporting)?
2. `session ask <id> "Summarize what you did and any open items"` — get a
   self-report from the child's own history
3. For isolated children: `git log <branch>` / `git diff` — inspect the
   actual commits, not just the child's claim
4. `session dashboard` — survey the whole fleet's health before declaring
   the overall goal done

A child that says "done" but left uncommitted changes, missed acceptance
criteria, or introduced regressions is NOT done. You catch this; the user
trusts you to catch this.

Only after YOUR verification passes should you report success to the user.
```

### Three Duties, One Identity

这三项职责不是三个独立功能, 而是 **同一个代理身份** 的三种表现:

```
                    ┌─────────────────────────┐
                    │  Orchestrator: 用户的代理人  │
                    └────────────┬────────────┘
               ┌─────────────────┼─────────────────┐
               ▼                 ▼                   ▼
        ┌──────────┐     ┌──────────────┐    ┌──────────────┐
        │ Dispatch  │     │ Act for User  │    │ Audit Quality │
        │ (派发)     │     │ (代用户决策)    │    │ (把关质量)     │
        └─────┬────┘     └──────┬───────┘    └──────┬───────┘
              │                  │                    │
    session send/create   session approve      session join/status
    <active-sessions>     session send (reply)  session ask (verify)
    injection             grant-approval        git log/diff (inspect)
              │                  │                    │
              ▼                  ▼                    ▼
        入口: 工作送对     运行中: 代用户判断      出口: 验证质量
```

**与 route-first 的关系**: route-first 是 dispatch 的实现机制 (入口); proactive audit 是 quality-gate (出口); acting-for-user 是运行中的代理行为 (中间)。三者共同构成完整的用户代理循环: 派发 → 代理决策 → 验证 → 交付。




## Reliability / Liveness Detection

A dependable Orchestrator is a PREREQUISITE of the "user's agent" identity. If the Orchestrator false-alarms "stalled" on healthy children, or silently hangs on truly stuck ones, it is neither a trustworthy agent nor a reliable coordinator. Liveness detection is not an add-on — it is the foundation that makes dispatch, act-for-user, and audit-quality trustworthy.

### Current State: Black-Box Detection (The Defect)

The stall watchdog (`spawn.ts:960`, T40) and `deriveLiveness` (`actor/schema.ts:73`, T39) only read **turn-boundary signals**: `turnCount` and `lastTurnTime`. These update only when a turn ENDS. During a single long turn — running tests, waiting on the LLM stream, reading big files — these timestamps are frozen.

From outside, a healthy long turn looks **identical to a hang**:
- Child is running `pytest` for 3 minutes → `lastTurnTime` frozen at turn start → `deriveLiveness` returns `stalled` after 90s (`DEFAULT_LIVENESS_STALL_MS`) → watchdog fires.
- Child is reading a 10MB log file → same pattern → false alarm.
- Child is waiting for LLM stream → same pattern → false alarm.

This false-alarm flood makes the Orchestrator feel unreliable ("always stalling") — the exact opposite of a dependable agent.

**Root cause**: black-box (turn-boundary timestamps) fundamentally cannot distinguish "long turn doing work" from "real hang". Both look like "no turn boundary for a while."

### Fix: White-Box Detection (Option A)

Add a **turn-internal activity heartbeat** — update a `lastActivityTime` every time the child produces a part (tool call / tool result / LLM token / reasoning), distinct from the turn-boundary `lastTurnTime`.

The watchdog then reads `now - lastActivityTime`:
- A long turn that's actually working keeps producing parts → activity time stays fresh → **NOT flagged**.
- A truly hung turn stops producing parts internally too → activity time freezes → **flagged**.

White-box (turn-internal activity) distinguishes "long turn doing work" from "real hang", which black-box (turn-boundary timestamps) fundamentally cannot.

**Implementation sketch**:
- In the turn execution loop (where parts are streamed/yielded), bump `lastActivityTime` on each part.
- `deriveLiveness` gains a new signal: `now - lastActivityTime <= stallMs` → progressing; otherwise → stalled.
- `lastTurnTime` still updates at turn boundaries (for backward compatibility).
- The watchdog reads `lastActivityTime` (not just `lastTurnTime`) for stall detection.

This aligns with the I1 heartbeat keystone — the heartbeat must fire at turn-INTERNAL activity points, not only at turn boundaries.

### Real-Hang Root Causes (The Other Half)

White-box detection kills **false stalls** (healthy long turns). The remaining question: what are the **true hangs** to fix?

| Root Cause | Status | Description |
|-----------|--------|-------------|
| Empty-tool-call loop | Being reverted | The mis-designed guard (auto-retry) caused infinite loops |
| Provider "call:" preamble leak | Being fixed | LLM provider emits malformed preamble that blocks processing |
| Cancel-order deadlock | Fixed (be0c322) | Race condition between cancel and turn execution |
| Orphaned child on old binary | Fixed (#1724, needs rebuild) | Child process stuck on stale binary after upgrade |
| Checkpoint-writer deadlock | Fixed (historical) | Checkpoint writer blocked on write lock |

With white-box detection, the Orchestrator can accurately distinguish:
- "This child is doing work but it's slow" → leave it alone (no false alarm)
- "This child is genuinely stuck" → nudge or cancel and re-dispatch (real hang)

### Unified Identity: Reliability as Agent Quality

The three pillars of the Orchestrator's identity are not independent features — they are expressions of the same principle: **the Orchestrator is the user's dependable agent**.

```
                    ┌─────────────────────────┐
                    │  Orchestrator: 用户的代理人  │
                    └────────────┬────────────┘
               ┌─────────────────┼─────────────────┐
               ▼                 ▼                   ▼
        ┌──────────┐     ┌──────────────┐    ┌──────────────┐
        │ Dispatch  │     │ Act for User  │    │ Reliability   │
        │ (派发)     │     │ (代用户决策)    │    │ (可信赖)       │
        └─────┬────┘     └──────┬───────┘    └──────┬───────┘
              │                  │                    │
    route-first             approve/answer      accurate liveness
    <active-sessions>       grant-approval      white-box heartbeat
    send/create             audit completion     no false alarms
              │                  │                    │
              ▼                  ▼                    ▼
        入口: 工作送对     运行中: 代用户判断      基础: 可信赖的状态
```

Reliability is the **foundation** — without accurate liveness, dispatch (route to a "stalled" child that's actually working) and audit (trust a "completed" report that's actually stuck) break down. A false "stalled" alarm causes the Orchestrator to nudge or cancel a healthy child; a missed stall causes it to wait forever. Either way, the user's agent is not dependable.

### Implementation Roadmap Addition

**Phase 1.5 (between Phase 1 and Phase 2)**: Add `lastActivityTime` heartbeat to turn execution, update `deriveLiveness` to use it, verify false-alarm rate drops. This is a prerequisite for the Orchestrator to reliably act on liveness signals in its dispatch and audit decisions.


## Code Impact Analysis

### 1. session 工具: 无新 verb, 仅清理

**File**: `packages/opencode/src/tool/session.ts`

| Current | Change | Impact |
|---------|--------|--------|
| `create` (line 613-739) | 保留, 移除 topic find-or-reuse 逻辑 (lines 621-661), 降级为纯创建 | 中等 — topic 逻辑移出 |
| `send` (line 742-810) | 保留不变, 成为主要操作 | 无 |
| `list` (line 813-883) | 保留, 新增 `summary` 返回格式供 context 注入使用 | 低 — 新增输出格式 |
| `topicOf` (line 187) | 保留但标记 deprecated; 不再是路由核心 | 低 |
| `tagTitle` (line 192) | 保留但标记 deprecated | 低 |

**关键: 没有新的 tool verb**。AI 直接用 `session send` 执行路由, 用 `session create` 作为 fallback。工具层零新增 API。

### 2. Harness 向 Orchestrator 注入活会话清单

**File**: `packages/opencode/src/session/llm.ts:240-306` (`buildSystemArray`)

在 `buildSystemArray` 中, 对 orchestrator agent 类型, 注入 `<active-sessions>` block:

```typescript
// After agent prompt assembly (line 260), before plugin transform (line 292)
if (input.agent.name === "orchestrator") {
  const sessionCtx = yield* buildActiveSessionsContext(input.sessionID)
  if (sessionCtx) system.push(sessionCtx)
}
```

`buildActiveSessionsContext` 是一个新函数, 复用 `list` 操作的数据获取逻辑 (lines 820-826), 输出极简 XML 格式 (一行一会话, 只含 id/title/mode/status), 过滤 terminal 状态会话。详见 R1.1 注入策略。

**注入时机**: 每次 Orchestrator 发起 LLM 请求时, system prompt 中包含最新的活会话快照。这意味着 Orchestrator 在做路由决策时, **不需要调用 `session list`** — 清单已经在上下文里了。

### 3. orchestrator.txt 决策指引

**File**: `packages/opencode/src/session/prompt/orchestrator.txt`

核心重写部分:

- **Line 1-5 (Identity)**: 从 "leader who accomplishes goals by delegating" 改为 "the user's agent — you make decisions on the user's behalf, not just relay messages"
- **Line 22-30 (The loop)**: 循环改为 "understand → route → yield → on notification: **audit + act for user** → integrate → report"
- **Line 48-59 (session tool reference)**: `send` 提升为主要操作, `create` 标注为 fallback; 新增 `approve`/`grant-approval` 作为代用户决策的核心操作
- **Line 82-88 (Reuse section)**: 从 "reuse per theme via topic" 改为 "see `<active-sessions>` — pick the best match and send"
- **新增 Route Decision section**: 指导 AI 如何利用 `<active-sessions>` 上下文做路由决策 (见 R2)
- **新增 Permission Decision section**: 指导 AI 代替用户批准/拒绝权限请求 (见 Duty 1)
- **新增 Answer Child Questions section**: 指导 AI 代替用户回答子会话问题 (见 Duty 2)
- **新增 Audit Completion section**: 指导 AI 主动验证子会话交付质量 (见 Duty 3)

### 4. 涉及文件汇总

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/opencode/src/session/llm.ts` | **修改** | `buildSystemArray` 中注入 `<active-sessions>` context |
| `packages/opencode/src/session/prompt/orchestrator.txt` | **修改** | 身份从 coordinator 升级为 user's agent; 新增 Route/Permission/Answer/Audit 四个 decision sections; send/approve 提升为主要操作 |
| `packages/opencode/src/tool/session.ts` | **修改** | `create` 中移除 topic find-or-reuse; `list` 新增 summary 格式 |
| `packages/opencode/src/session/prompt.ts` | **小改** | `buildActiveSessionsContext` 新函数 (可放此处或 llm.ts) |

**注意**: 没有新增 Zod schema, 没有新增 KNOWN_VERBS, 没有新增 tool verb。三项代理职责全部映射到现有 primitives。核心变更是 context injection + orchestrator.txt 重写。

## Implementation Roadmap

### Phase 1: Context Injection (harness 层, 不改产品行为)

**Goal**: Orchestrator 的 system prompt 中自动包含活会话清单, 但不改变任何路由行为。

1. 在 `llm.ts:buildSystemArray` 中, 对 orchestrator agent 注入 `<active-sessions>` XML block
2. 数据来源复用 `sessions.children` + `actorReg.get` + `deriveLiveness` (已有逻辑)
3. Orchestrator 现在能"看到"活会话列表, 但仍使用旧的 create-first 流程
4. **验证**: Orchestrator 的回复中能引用具体会话 ID 和状态 (证明它看到了清单)

**风险**: 注入增加 system prompt 大小。需要监控 token 使用。活会话数量通常 <10, 增量 <500 tokens。

### Phase 2: orchestrator.txt 重写 (prompt 层, 改变行为)

**Goal**: 通过 prompt 引导, 让 AI 优先 route-to-existing 而非 create。这是 **主体工作**。

1. 重写 orchestrator.txt 的核心循环和决策指引
2. 新增 "Route Decision" section: AI 如何从 `<active-sessions>` 中选择目标
3. 将 `send` 提升为主要操作, `create` 标注为 fallback
4. 移除旧的 topic-based reuse 指引
5. **验证**: Orchestrator 面对同主题的第二个任务时, 优先 `session send` 到已有会话

**风险**: prompt 引导是"软约束" — LLM 可能仍然偶尔 create。但这是 AI 路由的正确模型: 不是强制, 而是引导。如果引导不够强, 迭代 prompt (加 more explicit examples/constraints) 而非引入工具层匹配。

### Phase 3: 可选加强 (如果 Phase 2 的 prompt 引导不够)

**Goal**: 如果纯 prompt 引导后 Orchestrator 仍然过度 create, 加强引导而非引入匹配。

可能的加强手段 (按优先级):
1. **更强的 prompt 约束**: 在 orchestrator.txt 中加明确的 "MUST check active-sessions before create" + 反面示例
2. **create 前拦截**: 在 `session create` 的工具实现中, 如果 `<active-sessions>` 中有高度相关的会话, 返回 warning 而非直接创建 (注意: 这仍然是 AI 看到 warning 后自己决定, 不是工具自动匹配)
3. **指标监控**: 跟踪 create vs send 比率, 如果 create 率过高则迭代 prompt

**不做的事**: 启发式匹配、embedding 相似度、工具层自动路由。这些都违反 "AI routes" 原则。

### Phase 4: 清理 deprecated 路径

1. `--topic` 参数标记 deprecated, 保留向后兼容但不再推荐
2. `topicOf` / `tagTitle` 辅助函数标记 deprecated
3. orchestrator.txt 中移除旧的 topic-based reuse 指引
4. 更新 harness 文档 (`docs/harness/MiMo Orchestrator Mode.md`)

## Scope Boundaries

- **本设计不涉及**: 并发路由冲突处理 (多个 Orchestrator 实例路由到同一会话)、跨 Orchestrator 会话路由、session 持久化 schema 变更
- **本设计不实现**: 只出设计文档 + 实施路线, 不改产品代码
- **向后兼容**: `session create` 保持可用, `--topic` 保留但 deprecated, 现有 Orchestrator 行为在 Phase 1-2 期间不变

## Key Decisions

- **Orchestrator 是用户的代理人, 不是传声筒**: 核心身份从 "message router" 升级为 "user's agent/proxy"。三项职责 (dispatch/act-for-user/audit-quality) 共同构成完整的代理身份, 而非独立功能列表。
- **AI 做所有决策, 工具只提供信息+执行**: 路由决策、权限判断、质量审查全部由 AI 做。工具层不实现任何匹配逻辑, 也不代替用户做判断。
- **不需要新的 tool verb**: 所有三项职责都映射到现有 session tool primitives (send/create/approve/grant-approval/ask/join/status/dashboard)。最小化代码变更。
- **context injection 而非 on-demand query**: 活会话清单注入 system prompt, 让 Orchestrator 每次 turn 都能看到全貌 — 降低认知负担。
- **prompt 引导而非硬编码**: 所有行为 (路由、权限决策、质量审查) 通过 prompt 迭代优化, 而非工具层强制。

## Dependencies / Assumptions

- Orchestrator 当前是 experimental (flag-gated), 本 redesign 在 experimental 阶段实施, 无需 migration
- `sessions.children` + `actorReg.get` + `deriveLiveness` 已经提供了足够的会话状态数据
- 活会话数量通常 <20, context injection 的 token 开销可接受

## References

- `packages/opencode/src/tool/session.ts` — session tool 实现 (create/send/list/ask/approve/grant-approval/join/status/dashboard)
- `packages/opencode/src/session/prompt/orchestrator.txt` — orchestrator 系统提示词
- `packages/opencode/src/session/llm.ts:240-306` — system prompt 组装 (buildSystemArray)
- `packages/opencode/src/agent/agent.ts:231-251` — orchestrator agent 定义
- `packages/opencode/src/agent/config.ts:7-46` — `decideAskRouting` 权限转发决策
- `packages/opencode/src/permission/permission-forward-ref.ts` — 权限转发/授权 ref + 去重
- `docs/harness/MiMo Orchestrator Mode.md` — orchestrator 模式文档
- PR #1727 — 去掉 topic 字符串匹配 (止血, 非本 redesign)
