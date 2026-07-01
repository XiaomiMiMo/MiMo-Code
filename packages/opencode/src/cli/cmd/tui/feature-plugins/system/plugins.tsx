import path from "path"
import { Keybind } from "@/util"
import { Global } from "@/global"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiPluginStatus } from "@mimo-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { fileURLToPath } from "url"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@tui/context/language"
import { isPluginInstalled, loadMarketplace, type LoadResult, type MarketplacePlugin } from "./marketplace"
import { downloadPlugin, uninstallPlugin } from "@/plugin-marketplace/downloader"
import { DialogConfirm } from "@tui/ui/dialog-confirm"

const id = "internal:plugin-manager"
const key = Keybind.parse("space").at(0)
const add = Keybind.parse("shift+i").at(0)
const tab = Keybind.parse("tab").at(0)

function state(api: TuiPluginApi, item: TuiPluginStatus) {
  if (!item.enabled) {
    return <span style={{ fg: api.theme.current.textMuted }}>disabled</span>
  }

  return (
    <span style={{ fg: item.active ? api.theme.current.success : api.theme.current.error }}>
      {item.active ? "active" : "inactive"}
    </span>
  )
}

function source(spec: string) {
  if (!spec.startsWith("file://")) return
  return fileURLToPath(spec)
}

function meta(item: TuiPluginStatus, width: number) {
  if (item.source === "internal") {
    if (width >= 120) return "Built-in plugin"
    return "Built-in"
  }
  const next = source(item.spec)
  if (next) return next
  return item.spec
}

function Install(props: { api: TuiPluginApi }) {
  const [global, setGlobal] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  useKeyboard((evt) => {
    if (evt.name !== "tab") return
    evt.preventDefault()
    evt.stopPropagation()
    if (busy()) return
    setGlobal((x) => !x)
  })

  return (
    <props.api.ui.DialogPrompt
      title="Install plugin"
      placeholder="npm package name"
      busy={busy()}
      busyText="Installing plugin..."
      description={() => (
        <box flexDirection="row" gap={1}>
          <text fg={props.api.theme.current.textMuted}>scope:</text>
          <text fg={busy() ? props.api.theme.current.textMuted : props.api.theme.current.text}>
            {global() ? "global" : "local"}
          </text>
          <Show when={!busy()}>
            <text fg={props.api.theme.current.textMuted}>({Keybind.toString(tab)} toggle)</text>
          </Show>
        </box>
      )}
      onConfirm={(raw) => {
        if (busy()) return
        const mod = raw.trim()
        if (!mod) {
          props.api.ui.toast({
            variant: "error",
            message: "Plugin package name is required",
          })
          return
        }

        setBusy(true)
        void props.api.plugins
          .install(mod, { global: global() })
          .then((out) => {
            if (!out.ok) {
              props.api.ui.toast({
                variant: "error",
                message: out.message,
              })
              if (out.missing) {
                props.api.ui.toast({
                  variant: "info",
                  message: "Check npm registry/auth settings and try again.",
                })
              }
              show(props.api)
              return
            }

            props.api.ui.toast({
              variant: "success",
              message: `Installed ${mod} (${global() ? "global" : "local"}: ${out.dir})`,
            })
            if (!out.tui) {
              props.api.ui.toast({
                variant: "info",
                message: "Package has no TUI target to load in this app.",
              })
              show(props.api)
              return
            }

            return props.api.plugins.add(mod).then((ok) => {
              if (!ok) {
                props.api.ui.toast({
                  variant: "warning",
                  message: "Installed plugin, but runtime load failed. See console/logs; restart TUI to retry.",
                })
                show(props.api)
                return
              }

              props.api.ui.toast({
                variant: "success",
                message: `Loaded ${mod} in current session.`,
              })
              show(props.api)
            })
          })
          .finally(() => {
            setBusy(false)
          })
      }}
      onCancel={() => {
        show(props.api)
      }}
    />
  )
}

function row(api: TuiPluginApi, item: TuiPluginStatus, width: number): DialogSelectOption<string> {
  return {
    title: item.id,
    value: item.id,
    category: item.source === "internal" ? "Internal" : "External",
    description: meta(item, width),
    footer: state(api, item),
    disabled: item.id === id,
  }
}

function showInstall(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <Install api={api} />)
}

function View(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()
  const [list, setList] = createSignal(props.api.plugins.list())
  const [cur, setCur] = createSignal<string | undefined>()
  const [lock, setLock] = createSignal(false)

  createEffect(() => {
    const width = size().width
    if (width >= 128) {
      props.api.ui.dialog.setSize("xlarge")
      return
    }
    if (width >= 96) {
      props.api.ui.dialog.setSize("large")
      return
    }
    props.api.ui.dialog.setSize("medium")
  })

  const rows = createMemo(() =>
    [...list()]
      .sort((a, b) => {
        const x = a.source === "internal" ? 1 : 0
        const y = b.source === "internal" ? 1 : 0
        if (x !== y) return x - y
        return a.id.localeCompare(b.id)
      })
      .map((item) => row(props.api, item, size().width)),
  )

  const flip = (x: string) => {
    if (lock()) return
    const item = list().find((entry) => entry.id === x)
    if (!item) return
    setLock(true)
    const task = item.active ? props.api.plugins.deactivate(x) : props.api.plugins.activate(x)
    void task
      .then((ok) => {
        if (!ok) {
          props.api.ui.toast({
            variant: "error",
            message: `Failed to update plugin ${item.id}`,
          })
        }
        setList(props.api.plugins.list())
      })
      .finally(() => {
        setLock(false)
      })
  }

  return (
    <DialogSelect
      title="Plugins"
      options={rows()}
      current={cur()}
      onMove={(item) => setCur(item.value)}
      keybind={[
        {
          title: "toggle",
          keybind: key,
          disabled: lock(),
          onTrigger: (item) => {
            setCur(item.value)
            flip(item.value)
          },
        },
        {
          title: "install",
          keybind: add,
          disabled: lock(),
          onTrigger: () => {
            showInstall(props.api)
          },
        },
      ]}
      onSelect={(item) => {
        setCur(item.value)
        flip(item.value)
      }}
    />
  )
}

function show(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <View api={api} />)
}

function MarketplaceView(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()
  const t = useLanguage().t

  const [marketState, setMarketState] = createSignal<
    | { status: "loading" }
    | { status: "ready"; plugins: MarketplacePlugin[] }
    | { status: "error"; message: string }
  >({ status: "loading" })

  const [installing, setInstalling] = createSignal<string | undefined>()
  const plugins = createMemo(() => {
    const s = marketState()
    return s.status === "ready" ? s.plugins : []
  })

  // 已装标记：name → 是否已安装（isPluginInstalled 判定）
  const [installed, setInstalled] = createSignal<Record<string, boolean>>({})

  async function refreshInstalled() {
    const pluginsDir = path.join(Global.Path.data, "plugins")
    const entries = await Promise.all(
      plugins().map(async (p) => [p.name, await isPluginInstalled(path.join(pluginsDir, p.name))] as const),
    )
    setInstalled(Object.fromEntries(entries))
  }

  // generation guard：每次刷新递增 gen，过期请求（gen 不匹配）的结果被丢弃，
  // 避免后台静默检查覆盖用户刚手动刷新的新数据；卸载时 gen=-1 终止所有回调。
  let gen = 0
  onCleanup(() => {
    gen = -1
  })

  createEffect(() => {
    const width = size().width
    if (width >= 128) {
      props.api.ui.dialog.setSize("xlarge")
      return
    }
    if (width >= 96) {
      props.api.ui.dialog.setSize("large")
      return
    }
    props.api.ui.dialog.setSize("medium")
  })

  function applyResult(result: LoadResult, expected: number) {
    if (gen !== expected) return
    if (result.status === "ready") {
      setMarketState({ status: "ready", plugins: result.plugins })
      void refreshInstalled()
    } else {
      setMarketState({ status: "error", message: result.message })
    }
  }

  onMount(async () => {
    const myGen = gen
    const result = await loadMarketplace()
    applyResult(result, myGen)

    // 有缓存时，后台静默检查更新（不阻塞、不闪屏、失败忽略）。
    // 复用初始 gen=0：若用户已按 r（gen 已递增），此结果自动作废。
    if (result.status === "ready") {
      const updated = await loadMarketplace({ force: true }).catch(() => undefined)
      if (updated?.status === "ready") applyResult(updated, myGen)
    }
  })

  async function doRefresh() {
    setMarketState({ status: "loading" })
    const myGen = ++gen
    applyResult(await loadMarketplace({ force: true }), myGen)
  }

  async function doInstall(plugin: MarketplacePlugin) {
    if (installing()) return
    setInstalling(plugin.name)
    props.api.ui.toast({ variant: "info", message: t("tui.marketplace.install.start").replace("{0}", plugin.name) })

    // source 由 onSelect 保证存在（无 source 已被拦截）
    try {
      const result = await downloadPlugin(plugin.name, plugin.source!)

      if (!result.ok) {
        // 透传 result.error.message（如 schannel 握手失败 + 中文排查提示），
        // 避免只显示干巴巴的 code 让用户无从下手
        const detail = result.error instanceof Error ? `：${result.error.message}` : ""
        props.api.ui.toast({
          variant: "error",
          message: t("tui.marketplace.install.failed").replace("{0}", `${result.code}${detail}`),
        })
        return
      }
      if (result.skipped) {
        props.api.ui.toast({ variant: "info", message: t("tui.marketplace.install.skipped").replace("{0}", plugin.name) })
        return
      }
      props.api.ui.toast({ variant: "success", message: t("tui.marketplace.install.success").replace("{0}", plugin.name) })
      void refreshInstalled()
    } catch (error) {
      // 兜底：downloadPlugin 内部已捕获已知错误并返回 { ok:false }，
      // 这里防御未预期异常，避免 installing 信号卡死或 TUI 崩溃
      const message = error instanceof Error ? error.message : String(error)
      props.api.ui.toast({ variant: "error", message: t("tui.marketplace.install.failed").replace("{0}", message) })
    } finally {
      setInstalling(undefined)
    }
  }

  function doUninstall(plugin: MarketplacePlugin) {
    if (installing()) return
    // 二次确认：卸载即删目录，防误操作。用 dialog.replace 渲染 DialogConfirm，
    // onConfirm 回调里执行删除（api.ui.dialog 是包装对象，不含完整 DialogContext，
    // 故不能用 DialogConfirm.show 的 Promise 形式）。
    props.api.ui.dialog.replace(() => (
      <DialogConfirm
        title={t("tui.marketplace.uninstall.title")}
        message={t("tui.marketplace.uninstall.confirm").replace("{0}", plugin.name)}
        onConfirm={() => void runUninstall(plugin)}
        onCancel={() => showMarketplace(props.api)}
      />
    ))
  }

  async function runUninstall(plugin: MarketplacePlugin) {
    setInstalling(plugin.name)
    try {
      const result = await uninstallPlugin(plugin.name)
      if (!result.ok) {
        props.api.ui.toast({ variant: "error", message: t("tui.marketplace.uninstall.failed").replace("{0}", result.code) })
      } else if (!result.removed) {
        props.api.ui.toast({ variant: "info", message: t("tui.marketplace.uninstall.not_installed").replace("{0}", plugin.name) })
      } else {
        props.api.ui.toast({ variant: "success", message: t("tui.marketplace.uninstall.success").replace("{0}", plugin.name) })
        await refreshInstalled()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      props.api.ui.toast({ variant: "error", message: t("tui.marketplace.uninstall.failed").replace("{0}", message) })
    } finally {
      setInstalling(undefined)
      // dialog.replace 渲染确认框时覆盖了市场列表，无论结果如何都要恢复
      showMarketplace(props.api)
    }
  }

  const rows = createMemo(() => {
    const s = marketState()
    const mark = installed()
    if (s.status === "ready") {
      // 已装插件单独分组并置顶。gutter 放绿色加粗 ✓：Option 组件会把 footer
      // 的颜色强制覆盖成 muted（dialog-select.tsx），且 flat 搜索时 footer 还会
      // 被 category 文本替换，唯有 gutter 颜色不受覆盖，搜索/分组两种场景都显眼。
      return [...s.plugins]
        .sort((a, b) => (mark[a.name] ? 0 : 1) - (mark[b.name] ? 0 : 1))
        .map((p) => ({
          title: p.name,
          value: p.name,
          description: p.description,
          category: mark[p.name] ? t("tui.marketplace.category.installed") : t("tui.marketplace.category.available"),
          gutter: mark[p.name] ? (
            <text fg={props.api.theme.current.success} attributes={TextAttributes.BOLD}>
              ✓
            </text>
          ) : undefined,
        }))
    }
    // loading / error：列表区显示一条占位条目，保持界面框架完整
    const message =
      s.status === "error" ? `Failed to load: ${s.message}` : "Loading marketplace..."
    return [
      {
        title: message,
        value: "__status__",
        onSelect: () => {},
      },
    ]
  })

  return (
    <DialogSelect
      title={t("tui.command.plugins.marketplace.title")}
      flat
      options={rows()}
      onSelect={(item) => {
        const plugin = plugins().find((p) => p.name === item.value)
        if (!plugin?.source) {
          props.api.ui.toast({ variant: "info", message: t("tui.marketplace.no_source") })
          return
        }
        void doInstall(plugin)
      }}
      keybind={[
        { title: "refresh", keybind: Keybind.parse("ctrl+r").at(0), onTrigger: doRefresh },
        {
          title: "uninstall",
          keybind: Keybind.parse("ctrl+d").at(0),
          disabled: !!installing(),
          onTrigger: (item) => {
            const plugin = plugins().find((p) => p.name === item.value)
            if (!plugin) return
            if (!installed()[plugin.name]) {
              props.api.ui.toast({ variant: "info", message: t("tui.marketplace.uninstall.not_installed").replace("{0}", plugin.name) })
              return
            }
            void doUninstall(plugin)
          },
        },
      ]}
    />
  )
}

function showMarketplace(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <MarketplaceView api={api} />)
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => {
    const t = useLanguage().t
    return [
      {
        title: t("tui.command.plugins.list.title"),
        value: "plugins.list",
        keybind: "plugin_manager",
        category: "system",
        onSelect() {
          show(api)
        },
      },
      {
        title: t("tui.command.plugins.install.title"),
        value: "plugins.install",
        category: "system",
        onSelect() {
          showInstall(api)
        },
      },
      {
        title: t("tui.command.plugins.marketplace.title"),
        value: "plugins.marketplace",
        category: "system",
        onSelect() {
          showMarketplace(api)
        },
      },
    ]
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
