import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { createSignal, onCleanup } from "solid-js"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { titleReadback, unchangedTitle } from "../util/session-title"

interface DialogSessionRenameProps {
  session: string
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const sessionID = props.session
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  // Capture the edit base once; incoming AI/SSE never changes this draft.
  const currentSession = sync.session.get(sessionID)
  const initial = currentSession && { title: currentSession.title, titleRevision: currentSession.titleRevision }
  const [revision, setRevision] = createSignal(initial?.titleRevision)
  const [busy, setBusy] = createSignal(false)
  const [message, setMessage] = createSignal("")
  let active = true
  let saved = false
  let attempted = false
  let conflicted = false
  let draft = initial?.title ?? ""
  onCleanup(() => {
    active = false
    if (!saved && (draft !== initial?.title || attempted || busy()))
      toast.show({
        variant: "warning",
        message: busy()
          ? "Save result is not confirmed. Read the session before retrying."
          : "Title draft was not saved.",
      })
  })

  async function save(value: string) {
    if (busy()) return
    if (unchangedTitle(value, initial?.title, conflicted)) {
      draft = initial?.title ?? ""
      dialog.clear()
      return
    }
    const title = Array.from(value.trim()).slice(0, 80).join("")
    if (!title) {
      setMessage("Enter a nonempty title (up to 80 characters).")
      return
    }
    if (revision() === undefined) {
      setMessage("No confirmed engine session. Reload before renaming.")
      return
    }
    draft = value
    attempted = true
    setBusy(true)
    setMessage("")
    try {
      const response = await sdk.client.session.update(
        { sessionID: sessionID, title, expectedRevision: revision()! },
        { throwOnError: true, signal: AbortSignal.timeout(15000) },
      )
      if (!active) return
      if (!response.data || !sync.session.get(sessionID)) throw new Error("Session no longer available")
      sync.session.apply(response.data)
      saved = true
      toast.show({ variant: "success", message: "Title saved." })
      dialog.clear()
    } catch (error) {
      const rejectedConflict =
        typeof error === "object" && error !== null && "name" in error && error.name === "TitleConflictError"
      if (rejectedConflict) conflicted = true
      // A lost response may have committed. Never automatically resend it.
      try {
        const response = await sdk.client.session.get(
          { sessionID: sessionID },
          { throwOnError: true, signal: AbortSignal.timeout(15000) },
        )
        if (!active) return
        if (!response.data || !sync.session.get(sessionID)) throw new Error("Session no longer available")
        sync.session.apply(response.data)
        const current = sync.session.get(sessionID)!
        if (
          response.data.titleRevision === current.titleRevision &&
          (response.data.title !== current.title || response.data.titleSource !== current.titleSource)
        ) {
          setMessage(
            "The server returned conflicting titles for one revision. Save is not confirmed; your draft is retained.",
          )
          return
        }
        const outcome = titleReadback(revision(), title, current, rejectedConflict)
        if (outcome === "saved") {
          saved = true
          toast.show({ variant: "success", message: "The session is currently saved with this title." })
          dialog.clear()
          return
        }
        const conflict = outcome === "conflict"
        if (conflict) conflicted = true
        setRevision(current.titleRevision)
        setMessage(
          conflict
            ? `Conflict. Saved title: ${current.title}\nYour draft is retained below. Press Enter to explicitly save your title instead.`
            : "Save was not confirmed. Your draft is retained; press Enter to retry.",
        )
      } catch {
        if (active)
          setMessage(
            "Save could not be confirmed or the session was deleted. Your draft is retained; reload before retrying.",
          )
      }
    } finally {
      if (active) setBusy(false)
    }
  }

  return (
    <DialogPrompt
      title="Rename Session"
      value={initial?.title}
      busy={busy()}
      busyText="Saving title…"
      description={() => <text fg={theme.textMuted}>{message()}</text>}
      onChange={(value) => {
        draft = value
      }}
      onConfirm={(value) => {
        void save(value)
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
