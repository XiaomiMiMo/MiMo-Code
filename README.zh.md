<h1 align="center">Devora</h1>

<p align="center">
  <img src="assets/readme/devora-banner.png" alt="Devora" width="700">
</p>

<p align="center"><strong>Sheri Akhtamov 维护的开源 AI 编程智能体，拥有跨会话记忆。</strong></p>

<p align="center">
  中文 | <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/SheriAkhtamov/Devora">代码仓库</a> | <a href="https://github.com/SheriAkhtamov/Devora/releases">发布版本</a>
</p>

---

Devora 是 Sheri Akhtamov 维护的终端原生 AI 编程助手。它能读写代码、执行命令、管理 Git，通过持久化记忆系统，在多次会话间保持对你项目的深度理解，并自我进化。

内置 Devora Auto 限时免费通道——零配置即可开始使用。也支持接入各家主流 LLM 厂商 API。

---

## 快速开始

```bash
# 一键安装
curl -fsSL https://raw.githubusercontent.com/SheriAkhtamov/Devora/main/install | bash

# 或通过 npm 安装
npm install -g @devora-ai/cli
```

首次启动自动引导配置。支持：
- **Devora Auto（限时免费）** — 匿名通道，零配置
- **Devora 平台** — OAuth 登录
- **从 Claude Code 导入** — 一键迁移已有认证
- **自定义 Provider** — TUI 内添加任意 OpenAI 兼容 API

---

## 核心特性

### 多智能体

| 智能体 | 说明 |
|--------|------|
| **build** | 默认。完整工具权限，用于开发 |
| **plan** | 只读分析模式，适合代码探索和方案设计 |
| **compose** | 编排模式，适合 specs-driven 开发和 Skill 驱动流程 |

按 `Tab` 在主智能体间切换。子智能体由系统按需生成。

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

### 任务追踪

树状任务系统（T1, T1.1, T1.2…），自动与检查点系统联动，恢复会话时任务进度不丢失。

### 子智能体系统

主智能体可按需生成子智能体，共享当前会话上下文并行工作，支持生命周期追踪、取消机制和后台执行。

### Goal / 停止条件

`/goal` 命令为会话设置停止条件。当 agent 想停下来时，由独立裁判模型评估对话内容，判断条件是否真正满足——防止自主工作中的"乐观停止"。

### Compose 编排模式

Compose 模式提供结构化的 specs-driven 开发流程，内置规划、执行、代码审查、TDD、调试、验证、合并等技能——编排从 spec 到交付的完整开发生命周期。

### 语音输入

基于 TenVAD 和 Devora ASR 的实时流式语音输入。通过 `/voice` 激活，按停顿分片转写，文本逐段追加到输入框。仅对 Devora 登录用户可用。

### Dream & Distill

- **`/dream`** — 扫描近期会话轨迹，提取持久知识到项目记忆，清理过时条目
- **`/distill`** — 发现近期工作中重复的手动工作流，将高置信度候选打包成可复用的 skill、subagent 或 command

---

## 配置

通过项目目录下的 `.devora/devora.jsonc`（或全局 `~/.config/devora/devora.jsonc`）配置。主要选项包括：

- Provider 和模型选择
- Agent 权限和自定义 Agent
- 检查点和记忆行为
- MCP 服务器连接
- 快捷键和主题

Max Mode（并行 best-of-N 推理 + 裁判选优）可通过配置中的 `experimental.maxMode` 开启。

---

## 开发

```bash
bun install              # 安装依赖
bun run dev              # 开发模式运行
bun turbo typecheck      # 类型检查
```

---

## 项目

Devora 由 Sheri Akhtamov 维护在 [SheriAkhtamov/Devora](https://github.com/SheriAkhtamov/Devora)。该仓库包含 Devora 发行版的 CLI、桌面应用、Web UI、SDK、插件系统、发布脚本和更新配置。

---

## 社区

扫描二维码关注作者频道和社区入口：

<p align="center">
  <img src="assets/readme/community-qrcode-1.jpg" alt="社区群聊二维码 1" width="240">
  &nbsp;&nbsp;
  <img src="assets/readme/community-qrcode-2.jpg" alt="社区群聊二维码 2" width="240">
</p>

---

## 许可证

源代码基于 [MIT 许可证](./LICENSE) 开源。

使用 Devora 还需遵守[使用限制](./USE_RESTRICTIONS.md)。
Provider 托管服务须遵守你所配置 provider 的条款。
Devora 名称、标志和发行版品牌由 Sheri Akhtamov 维护。
