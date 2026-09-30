import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useLanguage } from "@tui/context/language"

export function DialogAgent(props: { force?: boolean }) {
  const local = useLocal()
  const dialog = useDialog()
  const { t } = useLanguage()

  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.name,
        title: item.name,
        description: item.native ? "native" : item.description,
      }
    }),
  )

  return (
    <DialogSelect
      title={props.force ? t("tui.dialog.agent.force.title") : "Select agent"}
      hint={props.force ? t("tui.dialog.agent.force.hint") : undefined}
      current={local.agent.current()?.name}
      options={options()}
      onSelect={(option) => {
        if (props.force) local.agent.forceSwitch(option.value)
        else local.agent.userSwitch(option.value)
        dialog.clear()
      }}
    />
  )
}
