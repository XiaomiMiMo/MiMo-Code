import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createResource, createMemo } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useLocal } from "@tui/context/local"
import { skillSelectOptions } from "./skill-command"

export type DialogSkillProps = {
  onSelect: (skill: string) => void
}

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const local = useLocal()
  dialog.setSize("large")

  const [skills] = createResource(async () => {
    const result = await sdk.client.app.skills()
    return result.data ?? []
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    return skillSelectOptions(skills() ?? [], {
      isCompose: local.agent.current()?.name === "compose",
      onSelect: (skill) => {
        props.onSelect(skill)
        dialog.clear()
      },
    })
  })

  return <DialogSelect title="Skills" placeholder="Search skills..." options={options()} />
}
