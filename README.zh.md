<h1 align="center">MiMoCode</h1>

<p align="center">
  <img src="assets/readme/mimocode-banner.png" alt="MiMoCode" width="700">
</p>

<p align="center"><strong>MiMo Code: Where Models and Agents Co-Evolve</strong></p>

<p align="center">
  中文 | <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://mimo.xiaomi.com/zh/mimocode">官网</a> | <a href="https://mimo.xiaomi.com/zh/blog/mimo-code-long-horizon">博客</a>
</p>

---

MiMoCode 是一个终端原生的 AI 编程助手。它能读写代码、执行命令、管理 Git，通过持久化记忆系统，在多次会话间保持对你项目的深度理解，并自我进化。

支持接入各家主流 LLM 厂商 API。

---

## 快速开始

```bash
# 一键安装（macOS / Linux）
curl -fsSL https://mimo.xiaomi.com/install | bash

# 一键安装（Windows PowerShell）
powershell -ep Bypass -c "irm https://mimo.xiaomi.com/install.ps1 | iex"

# 或通过 npm 安装（全平台）
npm install -g @mimo-ai/cli

# 运行
mimo
```

首次启动自动引导配置。支持：
- **小米 MiMo 平台** — OAuth 登录
- **Codex（ChatGPT Pro/Plus）** — OpenAI OAuth 登录
- **从 Claude Code 导入** — 一键迁移已有认证
- **Provider 列表** — 通过 API Key 接入目录内厂商，部分支持 OAuth（如 xAI/Grok）
- **自定义 Provider** — TUI 内添加任意 OpenAI 兼容 API

<details>
<summary><strong>WSL：剪贴板问题</strong></summary>

如果在 WSL 上复制出现乱码，安装 `xsel`：
```bash
sudo apt install xsel
```
</details>

<details>
<summary><strong>macOS：默认终端渲染异常</strong></summary>

MiMoCode 不支持 macOS 自带的“终端”（Terminal.app）。如果界面出现错位、闪烁或其他渲染异常，请改用 [iTerm2](https://iterm2.com/) 或 VS Code 集成终端：

```bash
brew install --cask iterm2
```
</details>

<details>
<summary><strong>TUI 卡顿与视觉动画问题</strong></summary>

如果通过 SSH 直接运行 TUI 时卡顿，可以让 TUI 在本地渲染，远端只运行 MiMoCode 服务。先在远端项目目录中启动服务：

```bash
# 远端主机
mimo serve --port 4096

# 本地主机：建立 SSH 端口转发
ssh -N -L 4096:127.0.0.1:4096 user@remote-host

# 本地主机：在另一个终端连接远端 MiMoCode
mimo attach http://127.0.0.1:4096
```

如果卡顿来自装饰性动画，可以运行 `/vivid`，或在 `ctrl+p` 命令面板中设置“丰富显示”，根据实际情况在丰富视觉模式和简洁模式间切换。

</details>

<details>
<summary><strong>Windows：shell 输出中文（CJK）乱码</strong></summary>

在系统区域为非 UTF-8 的 Windows 上（如简体中文，活动代码页为 936/GBK），命令输出里的
中日韩字符可能显示为乱码。MiMoCode 已为 PowerShell/cmd 子进程强制开启 UTF-8 输出。
如果在尚未覆盖的场景下仍遇到乱码，可以开启 Windows 的系统级 UTF-8 支持：

**设置 → 时间和语言 → 语言和区域 → 管理语言设置 → 更改系统区域设置 →
勾选「Beta 版: 使用 Unicode UTF-8 提供全球语言支持」→ 重启。**

这会把活动代码页（ACP）切换为 UTF-8（65001），所有程序都生效，子进程不再继承旧代码页。
注意这是系统级 Beta 开关，可能导致部分老的非 Unicode 程序显示异常，建议作为临时方案。
</details>

---

## MiMo 生态

除了 MiMoCode，小米 MiMo 模型也能在 Cursor、Cline、Zed 等各种 Agent 和编程工具里使用。

**[awesome-mimo-agent](https://github.com/XiaomiMiMo/awesome-mimo-agent)** 收集了这些工具接入 MiMo 模型的配置教程，想换个工具试试 MiMo 的话可以去看看。也欢迎把你自己的接入方式提 PR 分享出来。

---

## 核心特性

### 多智能体

| 智能体 | 说明 |
|--------|------|
| **build** | 默认。完整工具权限，用于开发 |
| **plan** | 只读分析模式，适合代码探索和方案设计 |
| **compose** | 编排模式，适合 specs-driven 开发和 Skill 驱动流程 |

按 `Tab` 在主智能体间切换。子智能体由系统按需生成。发送第一条消息后模式会锁定：Build 和 Plan 之间仍可互切，但 Compose 一旦进入即被隔离——skill/tool 集合从会话开始就保持固定，可显著提升工具调用成功率。

对于前沿模型（Fable/Sol 级），推荐用 **build** agent 配合 `/compose-next` 技能来完成 compose 类工作——见 [Compose 编排模式](#compose-编排模式)。

### 持久化记忆

基于 SQLite FTS5 全文搜索的跨会话记忆：

- **项目记忆** (`MEMORY.md`) — 跨会话持久的项目知识、规则、架构决策
- **会话检查点** (`checkpoint.md`) — 结构化状态快照，由 checkpoint-writer 子智能体自动维护
- **笔记暂存** (`notes.md`) — Agent 临时记录区
- **任务进展** (`tasks/<id>/progress.md`) — 逐任务日志

记忆自动在会话恢复时注入上下文，agent 无需重新理解项目背景。

### 智能上下文管理

- **自动检查点** — 根据模型上下文窗口自动决定什么时候保存会话状态
- **上下文重建** — 当上下文接近上限时，从最新 checkpoint、项目记忆、任务进展和保留的近期消息重建上下文，让 agent 继续当前任务
- **预算化注入** — 用 token budget 控制 checkpoint / memory / notes 注入上下文的大小，按重要性排序
- **压缩点可调** — `/context-limit`（或 `compaction.max_context`）让模型比自身窗口更早压缩，按模型生效

<details>
<summary><strong>比模型窗口更早压缩（<code>/context-limit</code>）</strong></summary>

压缩默认在略低于模型上下文窗口处触发。执行 `/context-limit` 可为当前模型选一个更小的工作预算
—— `200K` / `300K` / `500K` / `1M` 或自定义值 —— 按模型存为 `compaction.max_context`：

```jsonc
{
  "compaction": {
    "max_context": {
      "openai/gpt-5.6": "272K", // token 数、"300K"、"1M"，或窗口的 "50%"
      "anthropic/*": "300K" // 支持通配符，最长模式优先
    }
  }
}
```

该值始终会被 clamp 到厂商实际接受的上限，因此只能把压缩点调低，不能调高。填 `0` 恢复模型自身窗口。

什么时候需要它：

- **计费档位。** OpenAI 对 GPT-5.6 超过 272K input 的请求按 2x input、1.5x output 计费，且作用于整个请求。
- **标称窗口不等于你能用到的窗口。** 同一个模型经由 ChatGPT/Codex 订阅、直连 API key，还是 OpenRouter
  这类转售渠道，实际可用窗口可能不同 —— 目录里写 1M 不代表你这条链路给你 1M。
- **质量与延迟。** 上下文越长越慢，超过某个点也并不更好。

`mimo models <provider>` 会逐个模型打印 MiMoCode 解析出的窗口以及实际压缩的 token 数。输入框底部
用的就是同一个数字作分母（`33.0K/260K↓ (13%)`，`↓` 表示有预算生效），`/status` 里有完整拆解。

</details>

### 任务追踪

树状任务系统（T1, T1.1, T1.2…），自动与检查点系统联动，恢复会话时任务进度不丢失。

### 子智能体系统

主智能体可按需生成子智能体，共享当前会话上下文并行工作，支持生命周期追踪、取消机制和后台执行。

### Goal / 停止条件

`/goal` 命令为会话设置停止条件。当 agent 想停下来时，由独立裁判模型评估对话内容，判断条件是否真正满足——防止自主工作中的"乐观停止"。

### Compose 编排模式

Compose 是 MiMoCode 的 specs-driven 结构化开发流程，编排从 spec 到交付的完整开发生命周期。

推荐用法是在 **build** agent 中使用 **`/compose-next`** 技能：一份独立完整的契约，覆盖 grill → spec → workspace → implement → verify → review → finalize → finish，功能文档落在 `docs/compose/spec/<feature>.md`。它面向前沿模型（Fable/Sol 级）设计——这类模型已内化大部分流程，用一份紧凑契约效果最好。

Legacy 路径是专用的 **compose agent**（按 `Tab` 切换），它编排规划、执行、代码审查、TDD、调试、验证、合并等十四个内置技能——这套分步技能课程对较弱模型依然适用。

### Workflows

Workflow 是在沙箱运行时中执行的确定性 JavaScript 脚本，可编排多个 Agent 协作。与 Agent 对话不同，Workflow 编码了固定的阶段序列、有界重试和自动并行化——全程非交互，丢出去跑完即可。

MiMoCode 内置四个 Workflow：

| Workflow | 阶段 | 说明 |
|----------|------|------|
| `compose` | Brainstorm → Design → Implement → Verify → Review → Report → Merge | 完整开发流水线。自动将独立任务并行分发到隔离的 git worktree，每个任务应用 TDD，阶段之间传递结构化输出。适合需求明确且可拆分为独立子任务的场景。 |
| `deep-research` | Brief → Plan → Research → Reflect → Write → Review | 多源深度调研报告生成器。规划独立研究角度，并行派发子代理搜集带引用的 findings，反思补缺，单点写完整 Markdown 报告，最后冷审引用。支持断点续跑。 |
| `fact-check` | Plan → Search → Extract → Group → Crosscheck → Report | 对抗式事实验证。并行搜索网络、提取可验证事实、分组去重、用 3 人陪审投票交叉验证，只保留通过的结论。适合精确求证（"X 是否属实？"）。 |
| `research-experiment` | Baseline → Loop → Audit → Report | 面向可机械验证指标的自主优化循环。建立基线后反复执行“提出假设 → 实现 → 评估 → 保留/回滚”，审计指标作弊风险，并生成可复现的结果日志。需要固定预算的评估命令和明确的可编辑文件范围。 |

compose workflow 与交互式路径互补：**workflow** 适合需求清晰、任务可独立拆解的场景（确定性、并行、非交互）；**build** agent 配合 `/compose-next`（或 legacy 的 compose agent）适合需要中途改方向或在步骤间注入人工判断的场景（对话式、交互式）。

**自定义 Workflow：** 在 `.mimocode/workflows/` 或 `.claude/workflows/` 下放置 `.js` 文件即可定义自己的 Workflow，也可用同名文件覆盖内置 Workflow（如 `.mimocode/workflows/compose.js`）。

### 内置技能（Builtin Skills）

技能（Skill）是可复用的指令集，教会 Agent 如何处理特定任务（如生成 PDF、写学术论文、搜索 arXiv）。面对新任务时，MiMoCode 会按准确名称、本地化别名和 BM25 相关性搜索可用的非 Compose Skill；高置信度结果会自动加载，不确定的候选则交由 Agent 判断。在 TUI 中输入 `/` 可以浏览自动补全列表，也可以通过 `/<skill-name>` 直接调用 Skill——一条消息里提到两个及以上技能时会自动加载它们并注入多技能编排计划。

MiMoCode 打包了以下内置技能：

| 技能 | 说明 |
|------|------|
| `arxiv` | 搜索、阅读、引用和分析 arXiv 论文 |
| `claude-code` | 将编码、测试、审查和 Git 任务委派给 Claude Code CLI |
| `codex` | 在无头自动化、CI、容器和远程环境中运行及排查 Codex CLI |
| `compose-next` | 推荐的 spec→ship 功能交付工作流（grill → spec → implement → verify → review → finish）；通过 `/compose-next` 显式调用 |
| `data-analytics` | 通过数据质量、KPI、仪表盘、报告、Notebook 和市场规模测算等工作流分析产品与业务数据 |
| `deep-research` | 使用并行子智能体和内置 Web 工具生成带引用的多源深度调研报告 |
| `design-blueprint` | 动手做视觉前先出设计蓝图（DESIGN.md + 决策轨迹）|
| `docx-official` | 生成、读取和转换 Word (.docx) 文件 |
| `drive-mimo` | 以无头或交互式 TUI 模式编排、测试和自动化另一个 MiMoCode 进程 |
| `evolve` | 全面自我修改——改写 Agent 的任意层面：工具、行为钩子、知识、工作流，乃至界面本身 |
| `frontend-design` | UI 开发的视觉设计指导 |
| `html-to-video-pipeline` | 通过无头浏览器 + ffmpeg 将 HTML 渲染为 MP4 |
| `learn-everything` | 将文档、URL 或主题转化为包含练习、反馈和进度追踪的自适应课程 |
| `loop` | 按固定周期调度循环提示 |
| `mimocode-docs` | MiMoCode 功能、命令、Provider 和配置的自文档参考 |
| `modern-python-toolchain` | 使用 uv、Ruff 和 Pyright 配置现代 Python 项目 |
| `pdf-official` | 生成、读取、填充和转换 PDF 文件 |
| `pptx-official` | 制作和操作 PowerPoint (.pptx) 幻灯片 |
| `product-design` | 通过专项工作流探索、审查、实现和验证产品及 UX 设计 |
| `research-paper-writing` | 撰写和打磨学术论文（ML/CV/NLP 风格）|
| `sales` | 支持销售调研、会议准备、客户优先级、交易策略、预测和 CRM 工作流 |
| `skill-creator` | 创建和改进 Agent 技能的交互式指南 |
| `super-research` | 执行长周期、可审计的研究、实验、评测、诊断、论文复现和引用校验 |
| `xlsx-official` | 构建、清洗和转换电子表格 (.xlsx/.csv) |

`claude-code` 和 `codex` 仅在系统分别安装了 `claude` 和 `codex` 可执行文件时提供。其他技能也可能需要其说明中列出的任务专用工具。

**覆盖内置技能：** 在项目（`.mimocode/skills/<name>/SKILL.md`）或个人技能目录（`~/.claude/skills/`、`~/.opencode/skills/` 等）中创建同名技能即可。扫描顺序中后发现的用户技能会覆盖同名的内置技能。

<details>
<summary><strong>通过环境变量禁用内置技能</strong></summary>

| 变量 | 效果 |
|------|------|
| `MIMOCODE_DISABLE_BUILTIN_SKILLS=true` | 禁用所有内置技能 |
| `MIMOCODE_DISABLE_OFFICIAL_SKILLS=true` | 仅禁用办公/媒体类技能：`docx-official`、`pdf-official`、`pptx-official`、`xlsx-official`、`html-to-video-pipeline` |
| `MIMOCODE_DISABLE_SLASH_SKILLS=true` | 从 TUI 的 `/` 自动补全中隐藏 Skill，但不禁用它们 |

前两个选项会将对应技能从 Agent 可用技能列表中完全移除——不会出现在上下文中，也无法被调用。`MIMOCODE_DISABLE_SLASH_SKILLS` 仅影响 TUI 自动补全，Skill 对 Agent 仍然可用。

</details>

### 语音输入

基于 TenVAD 和 MiMo ASR 的实时流式语音输入。通过 `/voice` 激活，按停顿分片转写，文本逐段追加到输入框。仅对 MiMo 登录用户可用。需要安装 `sox`（macOS 上 `brew install sox`，其他平台类似）。

<details>
<summary><strong>WSLg 音频配置</strong></summary>

```bash
sudo apt install -y sox pulseaudio libasound2-plugins
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
```
</details>

<details>
<summary><strong>SSH 远程音频（Mac → 远程主机）</strong></summary>

```bash
# Mac（本地）
brew install pulseaudio
pulseaudio --load="module-native-protocol-tcp auth-ip-acl=127.0.0.1" --exit-idle-time=-1 --daemonize
# 在 ~/.ssh/config 中添加: RemoteForward 4713 127.0.0.1:4713

# 远程主机
apt install -y pulseaudio pulseaudio-utils sox
export PULSE_SERVER=tcp:127.0.0.1:4713
# 验证: pactl info
```
</details>

<details>
<summary><strong>非 MiMo 渠道语音输入（OpenRouter、内部 API 等）</strong></summary>

语音输入可通过 `voice` 配置字段路由到其他 OpenAI 兼容 provider。ASR 模型（`mimo-v2.5-asr`）仅在 MiMo 平台可用；语音控制模式（`mimo-v2.5`）可通过 OpenRouter 等中转平台使用。

**OpenRouter（仅语音控制）：**

使用 `/connect` 连接 OpenRouter 后，只需在配置中添加：
```jsonc
{
  "voice": {
    "control_model": "openrouter/xiaomi/mimo-v2.5"
  }
}
```

**内部 / 自建中转平台（ASR + 语音控制）：**
```jsonc
{
  "provider": {
    "internal": {
      "options": {
        "baseURL": "https://your-api-gateway.example.com/v1",
        "apiKey": "sk-..."
      },
      "models": {
        "xiaomi/mimo-v2.5-asr": { "name": "MiMo-V2.5-ASR" },
        "xiaomi/mimo-v2.5": { "name": "MiMo-V2.5" }
      }
    }
  },
  "voice": {
    "asr_model": "internal/xiaomi/mimo-v2.5-asr",
    "control_model": "internal/xiaomi/mimo-v2.5"
  }
}
```

自定义 provider 必须在 `models` 中注册至少一个模型才能被系统识别。`voice.*_model` 中的模型名直接传给 API，不必与注册的 key 完全一致。OpenRouter 等内置 provider 无需手动配置 models。

> **注意**：自定义 provider 注册的模型会出现在主模型选择列表中。请勿将 ASR 专用模型（如 `mimo-v2.5-asr`）用作编程主模型。

</details>

### Dream & Distill

- **`/dream`** — 扫描近期会话轨迹，提取持久知识到项目记忆，清理过时条目
- **`/distill`** — 发现近期工作中重复的手动工作流，将高置信度候选打包成可复用的 skill、subagent 或 command

---

## 配置

MiMoCode 使用 JSON/JSONC 配置文件，并提供 JSON Schema 以获得编辑器自动补全和校验。

### 文件位置

| 文件 | 项目级 | 全局 |
|------|--------|------|
| 主配置 | `.mimocode/mimocode.jsonc`（也支持 `.json`） | `~/.config/mimocode/mimocode.jsonc`（也支持 `.json`） |
| TUI 配置 | `.mimocode/tui.json` | `~/.config/mimocode/tui.json` |
| 认证凭据 | — | `~/.local/share/mimocode/auth.json` |

> Windows 下 XDG 路径位于 `%LOCALAPPDATA%\mimocode\`。可通过 `MIMOCODE_HOME` 环境变量覆盖所有路径。

### JSON Schema

MiMoCode 在首次加载配置时会自动注入 `$schema` 字段，使编辑器开箱即获得补全和校验：

| 配置文件 | Schema URL |
|----------|-----------|
| `mimocode.jsonc` / `mimocode.json` | `https://mimo.xiaomi.com/mimocode/config.json` |
| `tui.json` | `https://mimo.xiaomi.com/mimocode/tui.json` |

<details>
<summary><strong>VS Code / Cursor：信任 Schema 域名</strong></summary>

在 `settings.json` 中添加，使编辑器可以下载 Schema 以获得自动补全：

```json
{
  "json.schemaDownload.trustedDomains": {
    "https://mimo.xiaomi.com/": true
  }
}
```

</details>

<details>
<summary><strong>数据目录</strong></summary>

除配置文件外，MiMoCode 在 XDG 路径（或 `$MIMOCODE_HOME`）下存储运行时数据：

| 目录 | 默认路径（Linux） | 内容 |
|------|------------------|------|
| data | `~/.local/share/mimocode/` | SQLite 数据库、认证凭据（`auth.json`）、记忆、日志 |
| state | `~/.local/state/mimocode/` | TUI 偏好设置（`kv.json`）、最近使用模型（`model.json`） |
| cache | `~/.cache/mimocode/` | 语言服务器、缓存的模型目录、技能 |

如需删除已存储的凭据，删除 data 目录下的 `auth.json` 即可。macOS 下 XDG data 默认为 `~/Library/Application Support/mimocode/`。

</details>

### 自定义 OpenAI 兼容端点

如果 Provider 不在内置模型目录中，可以直接使用它的 Base URL、API Key 和模型 ID 进行配置：

```jsonc
{
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "model": "custom/MODEL_NAME",
  "provider": {
    "custom": {
      "name": "Custom",
      "npm": "@ai-sdk/openai-compatible",
      "only_configured_models": true,
      "models": {
        "MODEL_NAME": {
          "name": "MODEL_NAME"
        }
      },
      "options": {
        "baseURL": "BASE_URL",
        "apiKey": "API_KEY"
      }
    }
  }
}
```

- 必须使用准确的字段名 `baseURL` 和 `apiKey`。
- 原样保留用户提供的 Base URL 和模型 ID。MiMoCode 不要求 Provider 已存在于内置目录中；除非端点本身要求，否则不要自行增删 `/v1`。
- `models` 下的键是上游模型 ID。模型 ID 可以包含 `/`，因为 `model` 中只有第一个 `/` 用于分隔 Provider ID 和模型 ID。
- 如有需要，可将 `custom` 替换为其他未占用的小写 Provider ID，并同步更新顶层 `model` 中的 ID。
- `@ai-sdk/openai-compatible` 适用于 OpenAI 兼容 API；使用其他通信协议的服务需要对应 Provider 的专用适配器。

全局配置请写入 `~/.config/mimocode/mimocode.jsonc`（或同目录的 `mimocode.json`），仅项目生效的配置请写入 `.mimocode/mimocode.jsonc`（或 `.json`），并与已有内容合并。`apiKey` 会以明文保存在配置中，请确保文件仅当前用户可读，且不要提交到版本库。可运行 `mimo models` 或使用 TUI 模型选择器验证配置结果。

要声明自定义模型支持哪些输入模态（图片、音频、视频、PDF），在 TUI 中运行 `/modalities`——多选对话框会把设置持久化到配置，无需手动编辑。

### 主要选项

- Provider 和模型选择
- Agent 权限和自定义 Agent
- 检查点和记忆行为
- MCP 服务器连接
- 快捷键和主题

Max Mode（并行 best-of-N 推理 + 裁判选优）可通过配置中的 `experimental.maxMode` 开启。

<details>
<summary><strong>允许访问系统临时目录（<code>/tmp</code>）</strong></summary>

默认情况下，读写项目工作目录之外的文件会触发 `external_directory` 权限询问——系统临时目录也不例外。
这是有意为之：MiMoCode 不会静默放宽权限，你始终掌控模型在项目之外能触碰什么。

临时目录之所以经常被用到，是因为多数模型习惯把它当作临时工作空间（比如临时脚本、一次性数据文件）。
如果你信任所处环境、不想每次都被询问，可以在配置中主动放行：

```json title=".mimocode/mimocode.json"
{
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "permission": {
    "external_directory": {
      "/tmp/**": "allow"
    }
  }
}
```

**此设置存在已知风险——使用风险由你自行承担。** 临时目录对所有用户和进程可写，与机器上的其他进程
共享。自动放行意味着模型无需确认即可在其中读写，这会扩大你对“可预测临时路径 / 软链替换”一类攻击的
暴露面（例如其他进程提前把 `/tmp/foo` 创建为指向敏感文件的软链）。因此仅建议在单人、可控的环境或
容器内使用。请尽量缩小放行范围。

</details>

<details>
<summary><strong>跳过权限确认（<code>--dangerously-skip-permissions</code>）</strong></summary>

在可信、可丢弃的环境（容器、沙箱、CI）中，你可以让智能体自动放行所有操作，而不必逐个确认：

```bash
# TUI —— 启动时会弹出一次红色警告，需你明确接受风险
mimo --dangerously-skip-permissions

# 无头模式
mimo run --dangerously-skip-permissions "你的提示词"

# 或通过环境变量（任意入口）
MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS=1 mimo
```

它会在你的配置**下方**注入一条“全部放行”的基础规则，因此没有任何规则的工具会自动放行——但你写下的
任何显式规则仍然优先（最后匹配的规则生效，你的规则排在注入的 `*` 之后）。`deny` 依然拦截；注意残留的
`ask` 规则同样仍会弹出询问，而顶层 `"*": "ask"` 会让该参数失效。在 TUI 中会显示红色警告并要求你确认后
才生效（无 TTY 时会跳过该提示，因此在 CI 中会在无确认的情况下启用）。

**这非常危险。** 一旦跳过权限确认，恶意的提示词、文件或插件就能在无任何确认的情况下执行任意 Shell
命令，并读取、修改或窃取你的数据。请仅在你完全信任的工作区中使用。

更轻量的选择是 `/skip-permissions` 命令，在 TUI 运行时切换自动放行：`deny` 规则依然拦截，
强制确认的操作（如破坏性 bash）60 秒后自动拒绝并给出模型可处理的反馈，不会挂起。

</details>

---

## 开发

```bash
bun ci                   # 安装依赖(= bun install --frozen-lockfile)
bun run dev              # 开发模式运行
bun turbo typecheck      # 类型检查
```

---

## 与 OpenCode 的关系

MiMoCode 基于 [OpenCode](https://github.com/anomalyco/opencode) fork 构建，保留其全部核心能力（多 Provider、TUI、LSP、MCP、插件），并在此基础上构建了持久化记忆、智能上下文管理、子智能体编排、目标驱动的自主循环、Compose 工作流，以及通过 dream/distill 实现的自我进化。

---

## 社区

扫描二维码加入社区群聊：

<p align="center">
  <img src="assets/readme/community-qrcode-1.jpg" alt="社区群聊二维码 1" width="240">
  &nbsp;&nbsp;
  <img src="assets/readme/community-qrcode-2.jpg" alt="社区群聊二维码 2" width="240">
</p>

---

## 许可证

源代码基于 [MIT 许可证](./LICENSE) 开源。

使用 MiMoCode 还需遵守[使用限制](./USE_RESTRICTIONS.md)。
使用小米 MiMo 托管服务须遵守 [MiMo 服务条款](https://platform.xiaomimimo.com/docs/terms/user-agreement)。
使用 MiMo 名称、标志和商标须遵守 MiMo 商标政策。
