# MiMoCode 面向 GPT 模型的 Codex 微内核运行时

> “Codex 微内核运行时”是本文对当前架构的概括，不是源码中的正式模块名，也不表示操作系统级微内核。

## 摘要

MiMoCode 在共享 Session 引擎上运行 GPT/Codex 模型，同时向它们暴露一套更小的 Codex 风格工具 ABI：`bash`、`apply_patch`、`view_image` 和 `exec`。`exec` 在 QuickJS 中组合经过授权的宿主工具；权限、路径、子进程、取消、持久化和 UI 始终由宿主控制。

## 核心设计

MiMoCode 没有为 GPT 新建一套 Agent 引擎，而是在统一 Session runtime 上做三件事：

1. 使用 GPT/Codex 专属 system prompt，约定工具选择和调度方式；
2. 通过 `ToolRegistry` 装配更小的模型专属工具 ABI；
3. 提供 QuickJS `exec`，在不扩大权限的前提下组合宿主工具。

```mermaid
flowchart LR
    Model[GPT / Codex] --> Registry[SystemPrompt + ToolRegistry]
    Registry --> Direct[bash / apply_patch / view_image]
    Registry --> Exec[exec / QuickJS]
    Exec --> Tools[Filtered host tools]
    Direct --> Host[Permission + path guards]
    Tools --> Host
    Host --> Effects[Filesystem / Shell / MCP]
    Effects --> Session[SessionProcessor / MessageV2 / TUI]
```

核心原则是：

> 模型决定做什么，`exec` 负责如何组合，宿主决定是否允许以及如何产生副作用。

## GPT 工具 ABI

[`ToolRegistry.available()`](../../packages/opencode/src/tool/registry.ts#L363) 当前通过模型 ID 判断是否启用 GPT profile：ID 包含 `gpt-`，同时排除 `oss` 和 `gpt-4`。

| GPT 可见工具 | 作用 |
| --- | --- |
| `bash` | 使用 `rg`、`sed` 等检查和搜索文件，并执行命令 |
| `apply_patch` | 以结构化 patch 修改文本文件 |
| `view_image` | 将本地 JPEG、PNG、GIF、WebP 转为模型附件 |
| `exec` | 在 QuickJS 中批量调用和聚合宿主工具 |

GPT profile 会隐藏能力重叠的 `read`、`write`、`edit`、`multiedit`、`grep`、`glob` 和 `notebook_edit`。其他工具仍按 provider、agent allowlist 和运行时 permission 治理。

[`SystemPrompt.provider()`](../../packages/opencode/src/session/system.ts#L24) 独立选择 `gpt.txt`、`codex.txt` 或 `beast.txt`。Prompt 路由与工具 profile 目前是两套字符串规则，尚未统一成模型能力协商层。

## `exec` 微内核

[`ToolScriptTool`](../../packages/opencode/src/tool/tool-script.ts#L303) 对模型暴露为 `exec`。模型提交一个 TypeScript/JavaScript async function body，通过 `tools.<name>()` 调用宿主工具。

### 为什么不会绕过权限

[`tool-script-ref.ts`](../../packages/opencode/src/tool/tool-script-ref.ts#L1) 使用 late-bound registry，让 `exec` 取得和外层相同、已经过 model/agent 过滤的 `Tool.Def`：

- 外层不可见的 `read`、`write`、`edit` 不会在 `exec` 内重新出现；
- builtin 子调用执行原来的 `Tool.Def.execute()` 和 `Tool.Context`；
- MCP 子调用仍逐次执行 `ctx.ask()`；
- `exec_command` 只是 `bash` 的别名，权限和执行路径相同。

`task`、`actor`、`question`、`skill`、`workflow`、`cron`、`session` 等控制流工具被排除，因为它们改变对话或调度状态，不适合隐藏在一次脚本调用中。

### 两层安全边界

1. [`evalScript()`](../../packages/opencode/src/workflow/sandbox.ts#L106) 用 QuickJS 隔离 guest code，不提供 Node、`process`、`fetch`、timer 或模块加载；
2. 真正副作用仍由宿主工具执行，并经过 permission、external-directory、memory guard 和工具自身校验。

QuickJS 只隔离 `exec` 代码。`bash` 仍是真实 Shell，不是容器 sandbox。

### 资源限制

| 资源 | 默认值 / 上限 |
| --- | --- |
| 嵌套工具调用 | 默认 50，最高 500 |
| 并发调用 | 8 |
| 活跃计算 | 默认 60 秒，最高 600 秒 |
| Wall clock | 30 分钟 |
| Guest 内存 | 默认 64 MiB |
| 代码 / 返回值 / 日志 | 128 KiB / 256 KiB / 64 KiB |
| `files.*` 单文件 | 10 MiB |

`files.readText` 只能读取 worktree 或 OS tmp 内的 UTF-8 文本；`files.writeText` 只能写 OS tmp。项目变更必须调用受权限控制的宿主工具。

## 其他关键原语

### `apply_patch`

[`ApplyPatchTool`](../../packages/opencode/src/tool/apply_patch.ts#L24) 在写入前解析所有 hunks、检查路径、计算 diff 并请求 `edit` permission；写入后发布文件事件、运行格式化并刷新 LSP。

它会预验证全部 patch，但多文件写入不是事务性的，中途失败不会自动回滚已写文件。

### `view_image`

[`ViewImageTool`](../../packages/opencode/src/tool/view-image.ts#L23) 检查模型 image capability、external-directory 和 `read` permission，再验证图片格式并返回 data URL attachment。

当前限制：

- `detail` 只写入 metadata，不改变图片处理；
- 没有独立的图片大小限制；
- `exec` 只传递文本、metadata 和 JSON 值，不能透传图片 attachment，因此图片应直接调用 `view_image`。

## OpenAI Responses

OpenAI provider 通过 [`sdk.responses(modelID)`](../../packages/opencode/src/provider/provider.ts#L203) 发送请求。[`ProviderTransform.options()`](../../packages/opencode/src/provider/transform.ts#L1275) 默认设置 `store: false`，并为 GPT-5 reasoning 模型请求 `reasoning.encrypted_content`。

MiMoCode 将 provider metadata 写入消息并在下一轮回放，使无状态 Responses 工具循环可以继续推理；同时在发送前移除不可安全复用的 `itemId`，避免服务端或代理解析失效的 `rs_...` 引用。

[`CodexAuthPlugin`](../../packages/opencode/src/plugin/codex.ts#L364) 另行负责 ChatGPT Plus/Pro OAuth、token refresh、账户 header 和 Codex endpoint rewrite。它属于认证与传输层，不改变工具权限。

## PR 演化

[PR #1865](https://github.com/XiaomiMiMo/MiMo-Code/pull/1865) 是 stacked PR，base 指向 #1864 的 `feat/view-image-tool` 分支。它先完成：

- GPT 专属 Bash guidance；
- 隐藏重叠文件工具；
- 对齐 GPT/Claude 的 skill-search prompt 和 reminder。

[PR #1864](https://github.com/XiaomiMiMo/MiMo-Code/pull/1864) 随后继续加入 `view_image`、更完整的工具裁剪、`tool_script → exec`、GPT prompt、TUI 和 checkpoint 支持，最终整体合入 `main`。

当前 `skill_search` 仍向 GPT/Claude 暴露，但 system prompt 和 reminder 不主动要求它们搜索；这是 #1865 初始“隐藏工具”策略的后续调整。

## 当前缺口

- 模型分类依赖字符串启发式，Prompt 与工具 profile 规则可能漂移；
- `codex.txt` 仍提到 GPT profile 已隐藏的 Read/Edit/Write/Glob/Grep 工具；
- `view_image` 的暴露条件与执行期 image capability check 不完全一致；
- `files.readText` 依赖路径 jail，不执行普通 `read` permission ask；
- QuickJS 不能让 Bash 获得 OS 级隔离；
- [`registry-invocation-style.test.ts`](../../packages/opencode/test/tool/registry-invocation-style.test.ts#L17) 中 GPT `exec`、Bash description、`skill_search` 和 `multiedit` profile 用例目前被跳过。

## 关键源码

- [`session/system.ts`](../../packages/opencode/src/session/system.ts)：模型提示词路由；
- [`tool/registry.ts`](../../packages/opencode/src/tool/registry.ts)：GPT 工具 ABI；
- [`tool/tool-script.ts`](../../packages/opencode/src/tool/tool-script.ts)：`exec` 声明、dispatch、预算与结果；
- [`tool/tool-script-ref.ts`](../../packages/opencode/src/tool/tool-script-ref.ts)：同源工具过滤和控制流排除；
- [`workflow/sandbox.ts`](../../packages/opencode/src/workflow/sandbox.ts)：QuickJS sandbox；
- [`session/prompt.ts`](../../packages/opencode/src/session/prompt.ts)：工具执行上下文和 permission routing；
- [`provider/transform.ts`](../../packages/opencode/src/provider/transform.ts)：Responses reasoning round-trip。
