import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent, TuiSidebarFileItem } from "@mimo-ai/plugin/tui"
import { createMemo, For, Show, createSignal } from "solid-js"
import { sidebarPreview } from "../../util/sidebar-diff"

const id = "internal:sidebar-files"

export function FilesView(props: {
  files: ReadonlyArray<TuiSidebarFileItem>
  total?: number
  theme: Pick<TuiThemeCurrent, "text" | "textMuted" | "diffAdded" | "diffRemoved">
}) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.theme
  const list = () => props.files

  const preview = createMemo(() => sidebarPreview(list(), props.total))

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Modified Files</b>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <Show when={preview().omitted > 0}>
            <text fg={theme().textMuted}>
              Showing {preview().files.length} of {preview().total} files
            </text>
          </Show>
          <For each={preview().files}>
            {(item) => (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                <text fg={theme().textMuted} wrapMode="none">
                  {item.file}
                </text>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <Show when={item.additions}>
                    <text fg={theme().diffAdded}>+{item.additions}</text>
                  </Show>
                  <Show when={item.deletions}>
                    <text fg={theme().diffRemoved}>-{item.deletions}</text>
                  </Show>
                </box>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <FilesView
            files={api.state.session.diff(props.session_id)}
            total={api.state.session.diffTotal?.(props.session_id)}
            theme={api.theme.current}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
