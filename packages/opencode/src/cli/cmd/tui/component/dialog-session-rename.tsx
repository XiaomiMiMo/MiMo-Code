import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { useLanguage } from "@tui/context/language"

interface DialogSessionRenameProps {
  session: string
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const session = createMemo(() => sync.session.get(props.session))
  const { t } = useLanguage()

  return (
    <DialogPrompt
      title={t("tui.dialog.session_rename.title")}
      value={session()?.title}
      onConfirm={(value) => {
        void sdk.client.session.update({
          sessionID: props.session,
          title: value,
        })
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
