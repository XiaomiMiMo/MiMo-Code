import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import type { ConnectorStatus, PairingOutcome, PhoneStatus } from "@mimo-ai/connector"
import { createSignal } from "solid-js"
import { useLanguage } from "@tui/context/language"
import { createPhoneConnector, type PhoneConnector } from "@/phone/runtime"

const id = "internal:phone"
const ENABLED = "phone_enabled"

type Translate = ReturnType<typeof useLanguage>["t"]

const tui: TuiPlugin = async (api) => {
  const [status, setStatus] = createSignal<ConnectorStatus>({ state: "off" })
  /** Set while the pairing-code dialog is the one on screen. */
  let codeDialog: { close: () => void } | undefined
  /** The phone that claimed the current code. */
  let claimedBy = ""
  let t: Translate = (key) => key

  const phone: PhoneConnector = createPhoneConnector({
    client: () => api.client,
    events: api.event,
    version: api.app.version,
    host: {
      status: (next) => {
        const previous = status()
        setStatus(next)
        if (next.state === "unavailable" && previous.state !== "unavailable") void explainUnavailable(next.reason)
      },
      confirmPairing: (request) => {
        // The claim replaces the code dialog; closing it now must not cancel the pairing.
        codeDialog = undefined
        claimedBy = request.phoneName
        return confirm(api, t, request.phoneName)
      },
    },
  })
  api.lifecycle.onDispose(() => phone.dispose())
  if (api.kv.get(ENABLED, false)) void phone.connector.start()

  async function explainUnavailable(reason: Extract<ConnectorStatus, { state: "unavailable" }>["reason"]) {
    let message = t(`tui.phone.unavailable.${reason}`)
    if (reason === "not_signed_in") {
      const problem = await phone.identityProblem()
      if (problem) message = `${message} ${t(`tui.phone.identity.${problem}`)}`
    }
    api.ui.toast({ title: t("tui.command.phone"), message, variant: "warning", duration: 8000 })
  }

  async function pair() {
    claimedBy = ""
    const outcome = phone.connector.pair()
    const shown = await waitForCode()
    if (shown) {
      let open = true
      codeDialog = { close: () => (open = false) }
      api.ui.dialog.replace(
        () => (
          <api.ui.DialogAlert
            title={t("tui.phone.pairing.title")}
            message={t("tui.phone.pairing.code", { code: shown })}
          />
        ),
        () => {
          // Closed by the user while the code was still on screen: withdraw it.
          if (open && codeDialog) void phone.connector.cancelPairing()
          codeDialog = undefined
        },
      )
    }
    const result = await outcome
    if (codeDialog) {
      codeDialog.close()
      codeDialog = undefined
      api.ui.dialog.clear()
    }
    report(result)
  }

  /** The code appears in the status once the service issued it. */
  async function waitForCode(): Promise<string | undefined> {
    for (let i = 0; i < 100; i++) {
      const current = status()
      if (current.state === "online" && current.pairing) return current.pairing.code
      if (current.state !== "online") return undefined
      await Bun.sleep(50)
    }
    return undefined
  }

  function report(outcome: PairingOutcome) {
    if (outcome === "approved") {
      api.ui.toast({ message: t("tui.phone.paired", { name: claimedBy }), variant: "success" })
      return
    }
    api.ui.toast({
      message: t("tui.phone.pairing.ended", { outcome: t(`tui.phone.outcome.${outcome}`) }),
      variant: "info",
    })
  }

  function menu() {
    api.ui.dialog.replace(() => <Menu api={api} status={status()} actions={actions} />)
  }

  const actions: MenuActions = {
    on: () => {
      api.kv.set(ENABLED, true)
      api.ui.dialog.clear()
      void phone.connector.start()
    },
    off: () => {
      api.kv.set(ENABLED, false)
      api.ui.dialog.clear()
      void phone.connector.stop()
    },
    pair: () => {
      api.ui.dialog.clear()
      void pair()
    },
    remove: (target) => {
      api.ui.dialog.replace(() => (
        <api.ui.DialogConfirm
          title={t("tui.phone.remove.title", { name: target.phoneName })}
          message={t("tui.phone.remove.message")}
          onConfirm={() => {
            api.ui.dialog.clear()
            void phone.connector
              .unpair(target.bindingId)
              .catch((error: unknown) =>
                api.ui.toast({ message: error instanceof Error ? error.message : String(error), variant: "error" }),
              )
          }}
          onCancel={() => menu()}
        />
      ))
    },
  }

  api.command.register(() => {
    t = useLanguage().t
    return [
      {
        title: t("tui.command.phone"),
        value: "phone.open",
        category: "system",
        slash: { name: "phone" },
        onSelect: () => menu(),
      },
    ]
  })
}

type MenuActions = {
  on: () => void
  off: () => void
  pair: () => void
  remove: (phone: PhoneStatus) => void
}

type MenuValue = "on" | "off" | "pair" | { remove: PhoneStatus }

function Menu(props: { api: TuiPluginApi; status: ConnectorStatus; actions: MenuActions }) {
  const t = useLanguage().t
  const status = props.status
  const running = status.state === "online" || status.state === "reconnecting" || status.state === "starting"
  const phones = "phones" in status ? status.phones : []
  const options = [
    ...(running
      ? [
          ...(status.state === "online" && !status.pairing
            ? [
                {
                  title: t("tui.phone.action.pair"),
                  value: "pair" as MenuValue,
                  description: t("tui.phone.action.pair.description"),
                },
              ]
            : []),
          {
            title: t("tui.phone.action.off"),
            value: "off" as MenuValue,
            description: t("tui.phone.action.off.description"),
          },
        ]
      : [
          {
            title: t("tui.phone.action.on"),
            value: "on" as MenuValue,
            description: t("tui.phone.action.on.description"),
          },
        ]),
    ...phones.map((phone) => ({
      title: phone.phoneName,
      value: { remove: phone } as MenuValue,
      description: `${t(phone.canSend ? "tui.phone.phone.send" : "tui.phone.phone.read")} · ${t(
        phone.connected ? "tui.phone.phone.connected" : "tui.phone.phone.waiting",
      )}`,
      category: t("tui.phone.phones"),
    })),
  ]
  return (
    <props.api.ui.DialogSelect
      title={t("tui.phone.title", { state: t(`tui.phone.state.${status.state}`) })}
      options={options}
      onSelect={(option) => {
        const value = option.value
        if (value === "on") return props.actions.on()
        if (value === "off") return props.actions.off()
        if (value === "pair") return props.actions.pair()
        props.actions.remove(value.remove)
      }}
    />
  )
}

/** Ask the local user about a phone that claimed the code; closing the dialog declines. */
function confirm(api: TuiPluginApi, t: Translate, phoneName: string): Promise<{ canSend: boolean } | undefined> {
  return new Promise((resolve) => {
    let answered = false
    const answer = (value: { canSend: boolean } | undefined) => {
      if (answered) return
      answered = true
      resolve(value)
    }
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogSelect
          title={t("tui.phone.confirm.title", { name: phoneName })}
          options={[
            { title: t("tui.phone.confirm.send"), value: "send" },
            { title: t("tui.phone.confirm.read"), value: "read" },
            { title: t("tui.phone.confirm.decline"), value: "decline" },
          ]}
          onSelect={(option) => {
            answer(option.value === "decline" ? undefined : { canSend: option.value === "send" })
            api.ui.dialog.clear()
          }}
        />
      ),
      () => answer(undefined),
    )
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
