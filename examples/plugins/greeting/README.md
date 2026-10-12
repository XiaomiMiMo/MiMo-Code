# Greeting 插件开发项目

一个可复制的 MiMoCode 服务端插件项目，提供 `greet` 工具。源码保留在开发项目中，对外交付包含 `package.json`、`dist/server.js` 和说明文件的插件包。MiMoCode 根据包入口加载构建产物；SDK 和 `tool` 用到的运行时依赖已包含其中。

## 初始化

需要 Bun 和已完成首次配置的 MiMoCode。从 MiMoCode 仓库根目录复制示例到独立位置：

```bash
mkdir -p /tmp/example
cp -R examples/plugins/greeting /tmp/example/plugin-dev
cd /tmp/example/plugin-dev
```

此模板没有独立锁文件。**只在复制出的插件项目中**首次添加公开依赖，生成自己的 `bun.lock`：

```bash
bun add --dev @mimo-ai/plugin@0.1.15 @types/bun@1.3.11 typescript@5.8.2
```

提交插件项目的 `package.json` 和 `bun.lock`。之后在其他机器或 CI 中检出时，使用 `bun ci`。如果只是验证 MiMoCode 仓库中的示例，先在仓库根目录运行 `bun ci`，然后进入本目录执行下方脚本即可，无需修改仓库锁文件。

## 构建并交付插件包

在插件开发项目中运行：

```bash
bun run typecheck
bun run build
bun pm pack --ignore-scripts
```

`build` 将代码和运行时依赖打包进 `dist/server.js`；`pack` 再按 `package.json` 的 `files` 生成 `example-mimocode-greeting-1.0.0.tgz`，不会上传 npm。改了包名或版本后，压缩包名也会相应变化。

把这个压缩包交给使用者，或在本机解压到目标项目：

```bash
mkdir -p /tmp/example/project/.mimocode/extensions/greeting
tar -xzf ./example-mimocode-greeting-1.0.0.tgz -C /tmp/example/project/.mimocode/extensions/greeting --strip-components=1
```

解压后的目录包含 `package.json`、`dist/server.js`、`README.md`。`--strip-components=1` 去掉压缩包内部的 `package/` 外层目录。这个示例的部署目录不需要 `node_modules`，也不用安装 SDK。

在目标项目的 `/tmp/example/project/.mimocode/mimocode.json` 中合并：

```json
{
  "plugin": ["./extensions/greeting"]
}
```

这里引用的是**插件包目录**，MiMoCode 会读取其中 `package.json` 的 `./server` 导出。相对路径以配置文件为基准。如果选择直接传输文件夹，保留相同的包目录结构即可。退出目标项目中已经运行的 MiMoCode，再启动：

```bash
cd /tmp/example/project
mimo
```

### 轻量备选：单个 JavaScript 文件

这个示例的所有运行时依赖都已包含在一个文件中，也可以只复制 `dist/server.js` 到目标项目的 `.mimocode/plugins/greeting.js` 自动发现；这样就不需要 `plugin` 配置。包目录与单文件方式任选一种，避免重复加载。交付包含额外资源的插件时，优先保留完整插件包。

## 验证与迭代

在目标项目目录中可直接执行工具，无需让模型选择调用：

```bash
mimo debug agent build --tool greet --params '{"name":"Example"}'
```

返回 JSON 的 `result.output` 应为 `Hello, Example!`。此命令使用 MiMoCode 的默认模型配置来准备工具环境，但问候工具本身不请求模型，也不需要特定模型。

开发时在插件项目中运行 `bun run dev`，保存 `src/server.ts` 后会自动重新生成 `dist/server.js`。这个 watch 脚本只负责重新构建，不会自动部署或热重载插件。每次准备交付时运行 `bun run typecheck`、`bun run build` 和 `bun pm pack --ignore-scripts`，用新包更新目标目录，再重启验证。

开发调试可以将 `plugin` 配置指向 `file:///tmp/example/plugin-dev`，直接引用开发项目的包目录。MiMoCode 仍通过 `./server` 导出读取 `dist/server.js`；watch 构建后只需重启或重新运行 debug 命令，无需重复解压。不要同时保留部署版入口，对外仍交付构建好的插件包。

如果想发布自己的 npm 插件，先修改包名并移除 `private`，保留 `files` 与 `./server` 导出，确保发布包内有构建产物。本项目没有发布脚本。

更多服务端、TUI 和迁移说明见 [插件开发、部署与迁移指南](../../../docs/plugins.md)（在 MiMoCode 仓库中阅读）。
