# Plugin development and deployment

English | [简体中文](README.zh.md)

Use this Greeting plugin project as a starting point: write TypeScript and manage dependencies in a standalone project, bundle the entry point and runtime dependencies into JavaScript, and deliver a plugin package containing `package.json` and the build output. The project includes type checking, build, and watch scripts.

Use `@mimo-ai/plugin` as a development SDK in your plugin project. Declare dependencies there, bundle the runtime dependencies used by the plugin, and configure MiMoCode to load the finished package. For plugins distributed through npm, configure the published package name and version so the loader can install the package and its declared runtime dependencies.

## Understand where each plugin runs

| Type                                                    | Configuration and entry points                                                           | Who prepares dependencies                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Server plugins: tools, events, authentication, and more | `plugin` in `mimocode.json(c)`, or `plugin/` and `plugins/` in a configuration directory | Developers bundle local build output; the loader installs explicitly configured npm plugins |
| TUI plugins: commands, UI, themes, and more             | `plugin` in the separate `tui.json(c)`, or the `tui/` directory                          | Developers bundle their own dependencies; Solid/OpenTUI use the host's shared runtime       |

Server and TUI configuration are independent. A package can provide both entry points. Give each entry point a default export for its runtime: `server` for the server entry point and `tui` for the TUI entry point.

## Develop a server tool plugin

Prepare Bun, then copy the template from the MiMoCode repository root into a standalone project:

```bash
mkdir -p /tmp/example
cp -R examples/plugins/greeting /tmp/example/plugin-dev
cd /tmp/example/plugin-dev
```

The template's `package.json` uses public npm dependencies. Initialize **the copied plugin project's** own lockfile with:

```bash
bun add --dev @mimo-ai/plugin@0.1.15 @types/bun@1.3.14 typescript@5.8.2
```

Commit the plugin project's dependency declarations together with the generated `bun.lock`. On subsequent checkouts, use `bun ci` to restore the locked dependencies. Choose the SDK version based on API compatibility with your plugin. To validate this example directly in the MiMoCode repository, use the dependencies installed by `bun ci` at the repository root, then run the example's scripts in its directory.

Edit the project's [`src/server.ts`](src/server.ts) to define your tools. The greeting example provides:

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

`import type` and `satisfies` provide development-time checks and are erased during the build. `tool` is a runtime import: bundle it and the dependencies it actually uses with the output, or supply them in the deployment environment.

Check types, then build:

```bash
bun run typecheck
bun run build
```

The `build` script runs this command to bundle the example and its runtime dependencies into a single ESM file:

```bash
bun build ./src/server.ts --target=bun --format=esm --outfile=./dist/server.js
```

Use `typecheck` to validate types and `build` to bundle JavaScript and runtime dependencies. This example bundles the SDK and the dependencies it uses into `dist/server.js`, ready to deploy as a standalone file. For more complex plugins with native modules, dynamically loaded files, or additional assets, include those contents in your deployment and validate them in the target runtime environment.

Run `bun run dev` to watch source changes and rebuild `dist/server.js`. Copy the updated output to the deployment location and restart MiMoCode to load it.

## Deliver and configure a server plugin

Deliver a complete package directory or archive so MiMoCode can load the build output through the package entry point. A single JavaScript file is also a lightweight alternative. Configure one loading method for each plugin.

### Recommended: a plugin package directory or archive

In the plugin development project, check types, build, and then create a distributable archive:

```bash
bun run typecheck
bun run build
bun pm pack --ignore-scripts
```

`build` includes runtime dependencies. `pack` creates a local archive containing `package.json`, `dist/server.js`, `README.md`, and `README.zh.md`. This example produces `example-mimocode-greeting-1.0.0.tgz`; changing the package name or version changes the archive's filename accordingly.

Deliver the archive to users and extract it into the target project's plugin directory:

```bash
mkdir -p /tmp/example/project/.mimocode/extensions/greeting
tar -xzf ./example-mimocode-greeting-1.0.0.tgz -C /tmp/example/project/.mimocode/extensions/greeting --strip-components=1
```

`--strip-components=1` removes the archive's outer `package/` directory. The resulting `greeting/` directory contains `package.json`, `dist/server.js`, `README.md`, and `README.zh.md`; you can also transfer that package directory directly. These files contain everything this example needs at runtime.

Merge this into `/tmp/example/project/.mimocode/mimocode.json`:

```json
{
  "plugin": ["./extensions/greeting"]
}
```

The configuration references the extracted package directory. The loader reads `exports["./server"]` from its `package.json` and loads `dist/server.js`. Relative paths resolve from **the configuration file that declares them**. You can also use `"file:///tmp/example/project/.mimocode/extensions/greeting"`.

Give local plugin modules a stable `id`, such as `example.greeting` in this example. After changing deployed files or configuration, quit the running MiMoCode instance and restart it in the target project:

```bash
cd /tmp/example/project
mimo
```

### Lightweight alternative: a single JavaScript file

The example's runtime dependencies are already included in `dist/server.js`, so you can copy just that file:

```bash
mkdir -p /tmp/example/project/.mimocode/plugins
cp ./dist/server.js /tmp/example/project/.mimocode/plugins/greeting.js
```

Start MiMoCode in the target project to load the file through automatic discovery. `.mimocode/plugin/` is also supported; place built `*.js` files directly in the directory's top level. The same rules apply to `plugin/` and `plugins/` in the global configuration directory, which defaults to `~/.config/mimocode`.

To configure a file path explicitly, place the output at `.mimocode/extensions/greeting.js`, outside automatic discovery, and set `"plugin": ["./extensions/greeting.js"]` in `.mimocode/mimocode.json`. Choose one loading method: automatic discovery, an explicit file, or a package directory. Prefer a complete plugin package when you need additional assets or multiple entry points.

### Verification and everyday development

Run this in the target project directory:

```bash
mimo debug agent build --tool greet --params '{"name":"Example"}'
```

Complete MiMoCode's normal first-time setup so its default model configuration is available to prepare the tool environment. The debug command executes the greeting tool directly and returns JSON with `result.output` set to `Hello, Example!`. The tool builds its response locally from the supplied name.

The delivery workflow is: edit source → `bun run typecheck` → `bun run build` → `bun pm pack --ignore-scripts` → update the target package directory → restart and verify. During development, you can point `plugin` to `"file:///tmp/example/plugin-dev"` to reference the development project's package directory directly. The loader reads the build output through the `./server` export. With `bun run dev` running, save source files to rebuild, then restart or rerun the debug command. Keep the development package as the single configured entry while using this workflow.

## Configure TUI plugins separately

TUI plugins define their own entry points using types from `@mimo-ai/plugin/tui`. For example, this notification plugin in `src/tui.ts` uses the toast API:

```ts
import type { TuiPluginModule } from "@mimo-ai/plugin/tui"

export default {
  id: "example.notification",
  async tui(api) {
    api.ui.toast({ message: "Example plugin loaded", variant: "info" })
  },
} satisfies TuiPluginModule
```

This example has only type imports and can be built with:

```bash
bun build ./src/tui.ts --target=bun --format=esm --outfile=./dist/tui.js
```

Copy it to `/tmp/example/project/.mimocode/extensions/example-tui.js` and merge this into `/tmp/example/project/.mimocode/tui.json`:

```json
{
  "plugin": ["./extensions/example-tui.js"]
}
```

The TUI also automatically discovers built `*.js` files directly in `.mimocode/tui/` under the current working directory and in `tui/` under the global configuration directory. Choose either automatic discovery or an entry in `tui.json` for each plugin.

For plugins with UI components, use a build process compatible with OpenTUI's Solid JSX setup. Keep `solid-js`, `@opentui/solid`, `@opentui/core`, and their related subpaths as external dependencies (`external`) so the host's shared runtime manages reactive state and rendering. Bundle or supply the plugin's other runtime dependencies yourself. Build with the OpenTUI toolchain used by the target MiMoCode version and verify the actual UI.

## Distribute feature plugins through npm

To load a published npm plugin, add its package name and version to the `plugin` array, such as `"example-mimocode-plugin@1.0.0"`. Replace this example package name with an actual published plugin. Use `mimocode.json(c)` for server plugins and `tui.json(c)` for TUI plugins. The loader installs the configured package into its cache and resolves its declared runtime dependencies.

To publish a copy of this example, choose your package name, remove `private` from `package.json`, and build the plugin. For a package publishing only the server entry point above, the key fields can be:

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

To also provide a TUI plugin, build a separate `dist/tui.js` and add the required TUI export `"./tui": "./dist/tui.js"`. Before publishing, check that the package contains its entry files and required assets, and retain dependency declarations: bundled development dependencies can stay in `devDependencies`, runtime dependencies supplied through installation belong in `dependencies`, and shared UI runtimes should be declared as peer dependencies according to compatibility requirements.

## Develop directly from local source

For local source development, declare and install the source's runtime dependencies in a location where they resolve from the plugin file. The top level of server `plugin/` and `plugins/` directories supports `*.ts` and `*.js`; the top level of the TUI `tui/` directory supports `*.ts`, `*.tsx`, and `*.js`.

When preparing a plugin for delivery, build and package it using the workflow above. Keep development source in the development project and configure one deployed entry point in the target project.

## Troubleshoot loading

For dependency resolution errors, check the configured entry point and ensure each runtime import is bundled or resolves from the plugin file's location. For TUI entry point errors, check `tui.json(c)` and the package's `./tui` export. After correcting the configuration or deployment, restart MiMoCode and verify the plugin's tools or UI.
