# 插件开发与部署

[English](README.md) | 简体中文

以这个 Greeting 插件项目为起点：在独立项目中编写 TypeScript、管理依赖，将入口和运行时依赖打包为 JavaScript，以包含 `package.json` 和构建产物的插件包交付。该项目已提供类型检查、构建和 watch 脚本。

在插件项目中将 `@mimo-ai/plugin` 用作开发 SDK。在该项目中声明依赖，将插件用到的运行时依赖打包，再配置 MiMoCode 加载完成的插件包。通过 npm 分发的插件可直接配置已发布的包名和版本，由加载器安装插件包及其声明的运行时依赖。

## 先区分插件运行的位置

| 类型                           | 配置与入口                                                         | 依赖由谁准备                                           |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------ |
| 服务端插件：工具、事件、认证等 | `mimocode.json(c)` 的 `plugin`，或配置目录的 `plugin/`、`plugins/` | 本地产物由开发者打包；显式 npm 插件由加载器安装        |
| TUI 插件：命令、界面、主题等   | 独立的 `tui.json(c)` 的 `plugin`，或 `tui/` 目录                   | 自有依赖由开发者打包；Solid/OpenTUI 使用宿主共享运行时 |

服务端与 TUI 的配置彼此独立。一个包可以提供两个入口，每个入口按运行位置提供默认导出：服务端入口使用 `server`，TUI 入口使用 `tui`。

## 开发一个服务端工具插件

准备好 Bun，再从 MiMoCode 仓库根目录复制模板到独立项目：

```bash
mkdir -p /tmp/example
cp -R examples/plugins/greeting /tmp/example/plugin-dev
cd /tmp/example/plugin-dev
```

模板的 `package.json` 使用公开 npm 依赖。在**复制出的插件项目**中运行以下命令，初始化该项目自己的锁文件：

```bash
bun add --dev @mimo-ai/plugin@0.1.15 @types/bun@1.3.14 typescript@5.8.2
```

将插件项目的依赖声明和生成的 `bun.lock` 一起提交。后续检出该项目时用 `bun ci` 恢复锁定的依赖。根据插件所需的 API 兼容性选择 SDK 版本。直接在 MiMoCode 仓库中验证此示例时，使用仓库根目录的 `bun ci` 安装结果，再进入示例目录运行脚本。

编辑项目中的 [`src/server.ts`](src/server.ts) 来定义工具。问候工具示例如下：

```ts
import type { PluginModule } from "@mimo-ai/plugin"
import { tool } from "@mimo-ai/plugin/tool"

export default {
  id: "example.greeting",
  async server() {
    return {
      tool: {
        greet: tool({
          description: "Return a greeting for a name",
          args: {
            name: tool.schema.string().describe("Name to greet"),
          },
          async execute(args) {
            return `Hello, ${args.name}!`
          },
        }),
      },
    }
  },
} satisfies PluginModule
```

这里的 `import type` 和 `satisfies` 提供开发时的类型检查，并在构建时擦除。`tool` 是运行时导入，应将它和实际用到的依赖随产物打包，或在部署环境中提供。

先检查类型，再构建：

```bash
bun run typecheck
bun run build
```

`build` 脚本实际执行以下命令，将这个示例及其运行时依赖打包成一个 ESM 文件：

```bash
bun build ./src/server.ts --target=bun --format=esm --outfile=./dist/server.js
```

使用 `typecheck` 检查类型，使用 `build` 打包 JavaScript 和运行时依赖。这个示例将 SDK 及其用到的依赖一并包含在 `dist/server.js` 中，可将该文件独立部署。更复杂的插件若包含原生模块、动态加载的文件或额外资源，应将这些内容一起部署，并在目标运行环境验证。

运行 `bun run dev` 可监视源码变化并重新构建 `dist/server.js`。将更新后的产物复制到部署位置，再重启 MiMoCode 加载。

## 交付并接入服务端插件

推荐交付完整的包目录或压缩包，MiMoCode 根据包入口加载构建产物。单个 JavaScript 文件也可作为轻量备选。为每个插件选择一种加载方式。

### 推荐：插件包目录或压缩包

在插件开发项目中完成类型检查、构建，再生成可分发的压缩包：

```bash
bun run typecheck
bun run build
bun pm pack --ignore-scripts
```

`build` 包含运行时依赖，`pack` 在本地创建包含 `package.json`、`dist/server.js`、`README.md` 和 `README.zh.md` 的压缩包。示例生成 `example-mimocode-greeting-1.0.0.tgz`；修改包名或版本后，文件名会相应变化。

将压缩包交付给使用者，解压到目标项目的插件目录：

```bash
mkdir -p /tmp/example/project/.mimocode/extensions/greeting
tar -xzf ./example-mimocode-greeting-1.0.0.tgz -C /tmp/example/project/.mimocode/extensions/greeting --strip-components=1
```

`--strip-components=1` 去掉压缩包中的 `package/` 外层目录。得到的 `greeting/` 目录包含 `package.json`、`dist/server.js`、`README.md` 和 `README.zh.md`；也可以直接传输这样的包目录。这些文件已包含该示例运行所需的全部内容。

在 `/tmp/example/project/.mimocode/mimocode.json` 中合并：

```json
{
  "plugin": ["./extensions/greeting"]
}
```

配置引用的是解压后的包目录，加载器读取其中 `package.json` 的 `exports["./server"]` 并加载 `dist/server.js`。相对路径相对于**声明它的配置文件**解析；也可写 `"file:///tmp/example/project/.mimocode/extensions/greeting"`。

为本地插件模块提供稳定的 `id`，如示例中的 `example.greeting`。修改部署文件或配置后退出已经运行的 MiMoCode，然后在目标项目重新启动：

```bash
cd /tmp/example/project
mimo
```

### 轻量备选：单个 JavaScript 文件

示例的运行时依赖已包含在 `dist/server.js` 中，可以只复制该文件：

```bash
mkdir -p /tmp/example/project/.mimocode/plugins
cp ./dist/server.js /tmp/example/project/.mimocode/plugins/greeting.js
```

在目标项目启动 MiMoCode，即会通过自动发现加载该文件。`.mimocode/plugin/` 也支持；将构建后的 `*.js` 放在目录第一层。全局配置目录中的 `plugin/`、`plugins/` 使用相同规则；默认全局配置目录是 `~/.config/mimocode`。

如果希望显式配置文件路径，可将产物放在自动发现目录之外的 `.mimocode/extensions/greeting.js`，在 `.mimocode/mimocode.json` 中设置 `"plugin": ["./extensions/greeting.js"]`。自动发现、显式文件、包目录三种方式任选一种。需要附带资源或多个入口时，优先使用完整插件包。

### 验证与日常迭代

在目标项目目录运行：

```bash
mimo debug agent build --tool greet --params '{"name":"Example"}'
```

先完成 MiMoCode 正常的首次配置，以便它读取默认模型配置来准备工具环境。debug 命令直接执行问候工具，返回 JSON 的 `result.output` 应为 `Hello, Example!`。该工具根据传入的姓名在本地生成结果。

交付流程是：修改源码 → `bun run typecheck` → `bun run build` → `bun pm pack --ignore-scripts` → 更新目标包目录 → 重启并验证。开发时可让 `plugin` 指向 `"file:///tmp/example/plugin-dev"`，直接引用开发项目的包目录；加载器通过 `./server` 导出读取构建产物。运行 `bun run dev` 后，保存源码重新构建，再重启或重跑 debug 命令。使用这一流程时，将开发项目的包目录设为该插件唯一的配置入口。

## TUI 插件单独配置

TUI 插件通过 `@mimo-ai/plugin/tui` 中的类型定义自己的入口，例如使用 toast API 的通知插件 `src/tui.ts`：

```ts
import type { TuiPluginModule } from "@mimo-ai/plugin/tui"

export default {
  id: "example.notification",
  async tui(api) {
    api.ui.toast({ message: "Example plugin loaded", variant: "info" })
  },
} satisfies TuiPluginModule
```

这个示例只有类型导入，可用下面的命令构建：

```bash
bun build ./src/tui.ts --target=bun --format=esm --outfile=./dist/tui.js
```

将它复制为 `/tmp/example/project/.mimocode/extensions/example-tui.js`，在 `/tmp/example/project/.mimocode/tui.json` 中合并：

```json
{
  "plugin": ["./extensions/example-tui.js"]
}
```

TUI 还会自动发现当前工作目录下 `.mimocode/tui/` 与全局配置目录下 `tui/` 第一层的构建后 `*.js` 文件。为每个插件选择自动发现或 `tui.json` 配置中的一种加载方式。

包含 UI 组件的插件应使用匹配 OpenTUI Solid JSX 的构建流程。将 `solid-js`、`@opentui/solid`、`@opentui/core` 及其相关子路径保留为外部依赖（`external`），由宿主共享的运行时管理响应式状态和渲染。插件自己的其他运行时依赖应打包或自行提供。请依据目标 MiMoCode 版本所用的 OpenTUI 工具链构建，并实际验证界面。

## 通过 npm 分发功能插件

加载已发布的 npm 插件时，在 `plugin` 数组中填写包名和版本，例如 `"example-mimocode-plugin@1.0.0"`。使用时将这个示例包名替换为实际发布的插件。服务端填写 `mimocode.json(c)`，TUI 填写 `tui.json(c)`。加载器会将配置的插件包安装到缓存，并解析其声明的运行时依赖。

发布这个示例的副本时，先选择自己的包名，移除 `package.json` 中的 `private`，再构建插件。只发布上述服务端入口时，发布包的关键字段可以是：

```json
{
  "name": "example-mimocode-plugin",
  "version": "1.0.0",
  "type": "module",
  "files": ["dist"],
  "main": "./dist/server.js",
  "exports": {
    "./server": "./dist/server.js"
  }
}
```

若同时提供 TUI，构建独立的 `dist/tui.js`，并增加 TUI 必需的 `"./tui": "./dist/tui.js"` 导出。发布前检查包中确实包含入口文件及需要的资源，并保留依赖声明：已打包的开发依赖可留在 `devDependencies`，通过安装提供的运行时依赖应列入 `dependencies`，共享 UI 运行时按兼容性要求声明为 peer 依赖。

## 直接从本地源码开发

本地源码开发时，自行声明并安装源码用到的运行时依赖，确保它们能从插件文件所在位置解析。服务端的 `plugin/`、`plugins/` 第一层支持 `*.ts`、`*.js`；TUI 的 `tui/` 第一层支持 `*.ts`、`*.tsx`、`*.js`。

准备交付时，按上面的流程构建并打包。将开发源码保留在开发项目中，并在目标项目配置一个部署入口。

## 排查加载问题

出现依赖解析错误时，检查配置的入口，确保每个运行时导入已打包或能从插件文件所在位置解析。TUI 入口错误则核对 `tui.json(c)` 和包的 `./tui` 导出。修正配置或部署后，重启 MiMoCode 并验证插件的工具或界面。
