import { onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { InlineInput } from "@mimo-ai/ui/inline-input"
import { Button } from "@mimo-ai/ui/button"
import { titleConflict, unchangedTitle, type TitleSnapshot } from "./title-editor-state"

export function TitleEditor(props: {
  sessionID: string
  original: string
  baseRevision: number
  update: (input: { sessionID: string; title: string; expectedRevision: number }) => Promise<TitleSnapshot | undefined>
  apply: (snapshot: TitleSnapshot) => TitleSnapshot
  close: () => void
  error: (error: unknown) => void
  labels: { conflict: (title: string) => string; overwrite: string; cancel: string }
}) {
  // Each mount owns its opening snapshot and pending response lifetime.
  const initial = { sessionID: props.sessionID, original: props.original, baseRevision: props.baseRevision }
  const [state, setState] = createStore({
    draft: initial.original,
    pending: false,
    conflict: undefined as TitleSnapshot | undefined,
  })
  let active = true
  let input: HTMLInputElement | undefined
  onCleanup(() => {
    active = false
  })
  onMount(() => {
    input?.focus()
    input?.select()
  })

  const save = async (confirmed = false) => {
    if (!active || state.pending) return
    if (!state.draft.trim() || (!state.conflict && unchangedTitle(state.draft, initial.original))) {
      props.close()
      return
    }
    if (state.conflict && !confirmed) return
    setState("pending", true)
    try {
      const result = await props.update({
        sessionID: initial.sessionID,
        title: state.draft.trim(),
        expectedRevision: state.conflict?.titleRevision ?? initial.baseRevision,
      })
      if (!active) return
      if (!result || result.sessionID !== initial.sessionID) throw new Error("Title update returned no matching session snapshot")
      const current = props.apply(result)
      if (current.titleRevision > result.titleRevision && current.title !== result.title) {
        setState("conflict", current)
        return
      }
      props.close()
    } catch (error) {
      if (!active) return
      const current = titleConflict(error, initial.sessionID)
      if (current) setState("conflict", props.apply(current))
      else props.error(error)
    } finally {
      if (active) {
        setState("pending", false)
        input?.focus()
      }
    }
  }

  return (
    <div class="relative grow-1 min-w-0">
      <InlineInput
        ref={input}
        data-slot="session-title-child"
        value={state.draft}
        disabled={state.pending}
        class="text-14-medium text-text-strong w-full min-w-0 rounded-[6px] pl-1 -ml-1"
        style={{ "--inline-input-shadow": "var(--shadow-xs-border-select)" }}
        onInput={(event) => setState("draft", event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Enter") {
            event.preventDefault()
            void save()
          }
          if (event.key === "Escape") {
            event.preventDefault()
            props.close()
          }
        }}
        onBlur={() => {
          if (!state.pending && !state.conflict) props.close()
        }}
      />
      <Show when={state.conflict}>
        {(current) => (
          <div class="absolute top-full left-0 z-50 w-full rounded-[6px] border border-border-weak-base bg-background-stronger p-3 text-12-regular text-text-strong mt-2 break-words" role="alert">
            <p>{props.labels.conflict(current().title)}</p>
            <div class="flex flex-wrap gap-2 mt-2">
              <Button size="small" disabled={state.pending} onClick={() => void save(true)}>
                {props.labels.overwrite}
              </Button>
              <Button size="small" variant="ghost" onClick={props.close}>
                {props.labels.cancel}
              </Button>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
