import "../src/index.css"
import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import { createOpencodeClient } from "@mimo-ai/sdk/v2/client"
import { TitleEditor } from "../src/pages/session/title-editor"
import type { TitleSnapshot } from "../src/pages/session/title-editor-state"
import { dict } from "../src/i18n/en"
import { ThemeProvider } from "@mimo-ai/ui/theme"

function Fixture() {
  const fallback = new URLSearchParams(window.location.search).has("fallback")
  const [session, setSession] = createSignal<TitleSnapshot>({
    sessionID: "ses_a",
    title: fallback ? "Untitled" : "Opening title",
    titleSource: fallback ? "fallback" : "generated",
    titleRevision: fallback ? 0 : 1,
  })
  const [editing, setEditing] = createSignal(false)
  const [error, setError] = createSignal("")
  const client = createOpencodeClient({ baseUrl: window.location.origin })
  const apply = (snapshot: TitleSnapshot) => {
    if (snapshot.sessionID === session().sessionID && snapshot.titleRevision > session().titleRevision)
      setSession(snapshot)
    return session()
  }
  return (
    <main style={{ padding: "32px", width: "600px" }}>
      <h1>{session().title}</h1>
      <output data-testid="revision">{session().titleRevision}</output>
      <button onClick={() => setEditing(true)}>Rename</button>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setSession({ ...session(), title: "AI title", titleRevision: 2 })}
      >
        AI update
      </button>
      <button
        onClick={() => {
          setEditing(false)
          setSession({ sessionID: "ses_b", title: "Second session", titleSource: "user", titleRevision: 8 })
        }}
      >
        Switch session
      </button>
      <button onClick={() => setEditing(false)}>Close editor</button>
      <Show when={editing()}>
        <TitleEditor
          sessionID={session().sessionID}
          original={session().title}
          baseRevision={session().titleRevision}
          update={async (input) => {
            const response = await client.session.update(input, { throwOnError: true })
            return response.data && { ...response.data, sessionID: response.data.id }
          }}
          apply={apply}
          close={() => setEditing(false)}
          error={(error) => setError(String(error))}
          labels={{
            conflict: (title) => dict["session.title.conflict"].replace("{{title}}", title),
            overwrite: dict["session.title.overwrite"],
            cancel: dict["common.cancel"],
          }}
        />
      </Show>
      <p>{error()}</p>
    </main>
  )
}
render(() => <ThemeProvider><Fixture /></ThemeProvider>, document.getElementById("root")!)
