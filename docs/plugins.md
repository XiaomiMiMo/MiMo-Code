# 插件开发、部署与迁移

推荐从 [Greeting 插件开发项目](../examples/plugins/greeting) 开始：在独立项目中编写 TypeScript、管理依赖，将入口和运行时依赖打包为 JavaScript，以包含 `package.json` 和构建产物的插件包交付。该项目已提供类型检查、构建和 watch 脚本。

MiMoCode 启动时不再向全局配置目录或项目的 `.mimocode` 目录自动安装 `@mimo-ai/plugin`，也不再代装这些目录中 `package.json` 声明的依赖。依赖准备属于插件开发和构建过程。

内置功能随 MiMoCode 一起构建，不需要等待 npm 上发布同版本的 `@mimo-ai/plugin`。配置中明确指定的 npm 插件仍会按需安装，包括它声明的运行时依赖。`@mimo-ai/plugin` 是开发 SDK，本身不是应当加入 `plugin` 数组的功能插件。

## 先区分插件运行的位置

| 类型 | 配置与入口 | 依赖由谁准备 |
| --- | --- | --- |
| 服务端插件：工具、事件、认证等 | `mimocode.json(c)` 的 `plugin`，或配置目录的 `plugin/`、`plugins/` | 本地产物由开发者打包；显式 npm 插件由加载器安装 |
| TUI 插件：命令、界面、主题等 | 独立的 `tui.json(c)` 的 `plugin`，或 `tui/` 目录 | 自有依赖由开发者打包；Solid/OpenTUI 使用宿主共享运行时 |
| MiMoCode 内置功能 | 已包含在应用产物中 | 随应用构建，无需用户安装插件 SDK |

服务端与 TUI 的配置彼此独立。一个包可以提供两个入口，但每个入口的默认导出只能包含 `server` 或 `tui` 之一。

## 开发一个服务端工具插件

从 MiMoCode 仓库根目录复制模板到独立项目：

```bash
mkdir -p /tmp/example
cp -R examples/plugins/greeting /tmp/example/plugin-dev
cd /tmp/example/plugin-dev
```

模板的 `package.json` 使用公开 npm 依赖，没有 `workspace:` 或 `catalog:` 引用。模板不附带独立锁文件，因此首次在**复制出的插件项目**中运行：

```bash
bun add --dev @mimo-ai/plugin@0.1.15 @types/bun@1.3.11 typescript@5.8.2
```

将插件项目的依赖声明和生成的 `bun.lock` 一起提交。后续检出该项目时用 `bun ci` 恢复锁定的依赖。SDK 的版本选择取决于 API 兼容性，不需要与每一次 MiMoCode 应用发布的版本号相同。直接在 MiMoCode 仓库中验证此示例时，使用仓库根目录的 `bun ci` 安装结果即可，无需在示例目录重新添加依赖。

项目中的 [`src/server.ts`](../examples/plugins/greeting/src/server.ts) 定义了一个问候工具：

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

这里的 `import type` 和 `satisfies` 会在构建时擦除，部署环境不需要为了类型而安装 SDK。`tool` 则是运行时导入，它和实际用到的依赖必须随产物打包，或由部署环境提供。

先检查类型，再构建：

```bash
bun run typecheck
bun run build
```

`build` 脚本实际执行以下命令，将这个示例及其运行时依赖打包成一个 ESM 文件：

```bash
bun build ./src/server.ts --target=bun --format=esm --outfile=./dist/server.js
```

不要把 `tsc` 转译、压缩或生成 npm tarball 当作依赖打包：这些操作本身不会把裸包导入包含进 JavaScript。上面的示例没有将 SDK 或它用到的依赖标为 `external`，因此可单独部署 `dist/server.js`。更复杂的插件若包含原生模块、动态加载的文件或额外资源，需要另外安排这些内容的部署，并在目标运行环境验证。

运行 `bun run dev` 可监视源码变化并重新构建。它更新的是 `dist/server.js`，不负责复制或热重载；部署后仍需重启 MiMoCode。

## 交付并接入服务端插件

推荐交付完整的包目录或压缩包，MiMoCode 根据包入口加载构建产物。单个 JavaScript 文件也可作为轻量备选。不要同时配置同一插件的多个副本。

### 推荐：插件包目录或压缩包

在插件开发项目中完成类型检查、构建，再生成可分发的压缩包：

```bash
bun run typecheck
bun run build
bun pm pack --ignore-scripts
```

`build` 包含运行时依赖，`pack` 负责将 `package.json`、`dist/server.js` 和 `README.md` 归档，不会上传 npm。示例生成 `example-mimocode-greeting-1.0.0.tgz`；修改包名或版本后，文件名会相应变化。

将压缩包交付给使用者，解压到目标项目的插件目录：

```bash
mkdir -p /tmp/example/project/.mimocode/extensions/greeting
tar -xzf ./example-mimocode-greeting-1.0.0.tgz -C /tmp/example/project/.mimocode/extensions/greeting --strip-components=1
```

`--strip-components=1` 去掉压缩包中的 `package/` 外层目录。得到的 `greeting/` 目录包含 `package.json`、`dist/server.js` 和 `README.md`；也可以直接传输这样的包目录。这个示例部署后无需 `node_modules` 或 SDK 安装。

在 `/tmp/example/project/.mimocode/mimocode.json` 中合并：

```json
{
  "plugin": ["./extensions/greeting"]
}
```

配置引用的是包目录，加载器读取其中 `package.json` 的 `exports["./server"]` 并加载 `dist/server.js`。相对路径相对于**声明它的配置文件**解析；也可写 `"file:///tmp/example/project/.mimocode/extensions/greeting"`。这里配置的是解压后的目录，不是 `.tgz` 文件本身。

新式本地插件需要稳定的 `id`，如示例中的 `example.greeting`。修改部署文件或配置后退出已经运行的 MiMoCode，然后在目标项目重新启动：

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

在目标项目启动 MiMoCode 即会自动加载，无需 `plugin` 配置。`.mimocode/plugin/` 也支持；将构建后的 `*.js` 放在目录第一层。全局配置目录中的 `plugin/`、`plugins/` 使用相同规则；默认全局配置目录是 `~/.config/mimocode`。

如果希望显式配置文件路径，可将产物放在不参与自动发现的 `.mimocode/extensions/greeting.js`，在 `.mimocode/mimocode.json` 中设置 `"plugin": ["./extensions/greeting.js"]`。自动发现、显式文件、包目录三种方式任选一种。需要附带资源或多个入口时，优先使用完整插件包。

### 验证与日常迭代

在目标项目目录运行：

```bash
mimo debug agent build --tool greet --params '{"name":"Example"}'
```

命令返回 JSON，`result.output` 应为 `Hello, Example!`。它直接执行工具，不需要模型决定是否调用。MiMoCode 仍会读取默认模型配置来准备工具环境，因此先完成正常的首次配置；这个问候工具不请求模型，也不要求特定模型。

交付流程是：修改源码 → `bun run typecheck` → `bun run build` → `bun pm pack --ignore-scripts` → 更新目标包目录 → 重启并验证。开发时可让 `plugin` 指向 `"file:///tmp/example/plugin-dev"`，直接引用开发项目的包目录；加载器仍通过 `./server` 导出读取构建产物。运行 `bun run dev` 后，保存源码会重新构建，只需重启或重跑 debug 命令，无需每次解压。不要同时保留开发版与部署版入口。

## TUI 插件单独配置

TUI 插件通过 `@mimo-ai/plugin/tui` 中的类型定义自己的入口，例如不包含 JSX 的通知插件 `src/tui.ts`：

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

TUI 还会自动发现当前工作目录下 `.mimocode/tui/` 与全局配置目录下 `tui/` 第一层的构建后 `*.js` 文件。使用自动发现时，不要再在 `tui.json` 中重复声明。

包含 UI 组件的插件需要匹配 OpenTUI 的 Solid JSX 构建流程，不能直接套用上述无 JSX 示例。`solid-js`、`@opentui/solid`、`@opentui/core` 及其相关子路径应保留为外部依赖（`external`），使用宿主共享的运行时；把第二份 Solid/OpenTUI 打进插件可能破坏响应式状态和渲染。插件自己的其他运行时依赖仍需打包或自行提供。请依据目标 MiMoCode 版本所用的 OpenTUI 工具链构建，并实际验证界面。

## 通过 npm 分发功能插件

加载器仍支持在 `plugin` 数组中写 npm 包名和版本，例如 `"example-mimocode-plugin@1.0.0"`；这是示例包名，使用时替换为实际发布的插件。服务端填写 `mimocode.json(c)`，TUI 填写 `tui.json(c)`。加载器会将明确配置的 npm 插件安装到缓存，并解析其依赖；因此，该插件若仍声明了 `@mimo-ai/plugin` 等运行时依赖，安装时依然可能下载它们。

只发布上述服务端入口时，发布包的关键字段可以是：

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

若同时提供 TUI，构建独立的 `dist/tui.js`，并增加 `"./tui": "./dist/tui.js"` 导出。TUI 包必须提供 `./tui` 入口；只有 `main` 或 `exports["."]` 不够。发布前检查包中确实包含入口文件及需要的资源，并保留依赖声明：已打包的开发依赖可留在 `devDependencies`，仍需安装的运行时依赖应列入 `dependencies`，共享 UI 运行时按兼容性要求声明为 peer 依赖。

## 从旧版自动安装行为迁移

如果现有插件已经是依赖齐全的 npm 包或可独立运行的构建产物，通常无需调整。本地源码插件若之前依赖 MiMoCode 自动安装 SDK，推荐迁移到独立开发项目并构建后部署：

1. **构建后部署。** 将源码移到自己的开发项目，在那里声明并安装依赖，按上面的方式构建，将产物部署到插件入口。保留源码时将它放在自动扫描目录之外，避免源码和产物同时加载。
2. **暂时保留源码的兼容方式。** 现有源码入口仍可加载：服务端的 `plugin/`、`plugins/` 第一层支持 `*.ts`、`*.js`，TUI 的 `tui/` 第一层支持 `*.ts`、`*.tsx`、`*.js`。自行声明并安装源码用到的所有运行时依赖，确保它们能从插件文件所在位置解析到；只在另一个开发目录或全局安装 SDK 并不足够。这用于旧插件迁移或本地调试，新插件仍建议采用构建产物部署。

旧版可能已在全局配置目录或 `.mimocode` 中写入 `package.json`、`package-lock.json`、`node_modules`。升级不会自动删除这些文件。先确认其中是否还有自定义依赖、其他插件或工具在使用，再决定是否清理；不要为迁移直接删除整个 `.mimocode` 目录。

如果日志出现找不到 `@mimo-ai/plugin` 或其他包，检查加载的是源码还是构建产物、产物是否仍有未提供的裸包导入、依赖能否从插件所在位置解析。TUI 入口错误则先核对配置文件和 `./tui` 导出。完成修复后重新启动验证。

旧安装逻辑使用的是应用中的 JavaScript 库 `@npmcli/arborist`，并不要求系统安装一个 `npm` 命令。取消配置加载时的自动安装，解决的是隐式依赖管理及其对 SDK 发布的耦合；显式 npm 插件安装仍使用应用的包安装能力。
