# Atomic Chat

[Atomic Chat](https://atomic.chat) 在本地通过 OpenAI 兼容 API 提供模型服务，默认地址为 `http://127.0.0.1:1337/v1`。

MiMoCode 会从 [models.dev](https://models.dev) 自动加载 `atomic-chat` 提供商。除非需要覆盖 Base URL 或模型列表，否则无需手动配置自定义 Provider。

## 快速开始

1. 安装并启动 [Atomic Chat](https://atomic.chat)（macOS Apple Silicon）。
2. 在应用中下载或加载一个模型。
3. 确认 API 可用：`curl http://127.0.0.1:1337/v1/models`
4. 在 MiMoCode TUI 或桌面端连接 **Atomic Chat** 提供商。
5. 选择模型（例如 `atomic-chat/<model-id>`）。

本地使用通常不需要 API Key。除非你的环境要求认证，否则无需设置 `ATOMIC_CHAT_API_KEY`。

## 可选配置覆盖

项目配置：`.mimocode/mimocode.json`  
全局配置：`~/.config/mimocode/mimocode.json`

可参考 [examples/mimocode.atomic-chat.jsonc](../examples/mimocode.atomic-chat.jsonc)，用最小配置指向默认本地端点并声明 Atomic Chat 中已加载的模型。

## 提示

- Agent 工作流（含 tool call）建议使用能力更强的编程模型。
- 上下文较小时，优先选择更小模型或缩小任务范围。
- 模型 ID 必须与 Atomic Chat `GET /v1/models` 返回的 `id` 一致。

## 链接

- [Atomic Chat 官网](https://atomic.chat)
- [Atomic Chat GitHub](https://github.com/AtomicBot-ai/Atomic-Chat)
