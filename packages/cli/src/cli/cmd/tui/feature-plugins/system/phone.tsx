import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import {
  PassportLoginError,
  SERVICE_TOKEN_LIFETIME_MS,
  type ConnectorStatus,
  type LoginAttempt,
  type PairingOutcome,
  type PhoneStatus,
} from "@mimo-ai/connector"
import { createSignal, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import open from "open"
import { useLanguage } from "@tui/context/language"
import * as Clipboard from "@tui/util/clipboard"
import { DialogSelect } from "@tui/ui/dialog-select"
import { platformUserIds } from "@/phone/identity"
import { qrBlocks } from "@/phone/qr"
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

  /** The signed-in Xiaomi account as the panel shows it; refreshed when the panel opens. */
  type AccountView = { userId: string; name?: string } | undefined
  let account: AccountView
  let nickname: { userId: string; name?: string } | undefined
  let warnedFileStorage = false
  const passport = phone.account.passport

  async function readAccount(): Promise<AccountView> {
    const credential = await passport.credential().catch(() => undefined)
    if (!credential) return undefined
    if (nickname?.userId !== credential.userId) {
      nickname = { userId: credential.userId, name: await passport.nickname() }
    }
    return { userId: credential.userId, name: nickname.name }
  }

  /** Tell once per run that secrets went to a user-only file instead of protected storage. */
  async function noteStorage() {
    if (warnedFileStorage || (await phone.account.secrets.kind()) !== "file") return
    warnedFileStorage = true
    api.ui.toast({ title: t("tui.command.phone"), message: t("tui.phone.storage.file_warning"), variant: "warning", duration: 10000 })
  }

  /** Sign in with the Xiaomi account, then continue with `then` (start, pair) once signed in. */
  async function login(then?: () => void) {
    let attempt: LoginAttempt
    try {
      attempt = await passport.signIn()
    } catch {
      // A toast under an open dialog is drawn beneath it: close the menu first.
      api.ui.dialog.clear()
      api.ui.toast({ message: t("tui.phone.login.start_failed"), variant: "error" })
      return
    }
    const controller = new AbortController()
    let finished = false
    api.ui.dialog.replace(
      () => <LoginDialog api={api} attempt={attempt} />,
      () => {
        if (!finished) controller.abort()
      },
    )
    if (canOpenBrowser()) void open(attempt.loginUrl).catch(() => {})
    try {
      const tokens = await attempt.wait(controller.signal)
      finished = true
      api.ui.dialog.clear()
      account = await readAccount()
      api.ui.toast({
        message: t("tui.phone.login.done", { name: account?.name ?? maskUser(tokens.userId) }),
        variant: "success",
      })
      const platform = await platformUserIds()
      if (platform.length && !platform.includes(tokens.userId)) {
        api.ui.toast({ message: t("tui.phone.login.other_account"), variant: "warning", duration: 10000 })
      }
      await noteStorage()
      then?.()
    } catch (error) {
      finished = true
      const code = error instanceof PassportLoginError ? error.code : "network"
      if (code === "cancelled") return
      api.ui.dialog.clear()
      api.ui.toast({ message: t(`tui.phone.login.failed.${code}`), variant: code === "expired" ? "warning" : "error" })
    }
  }

  async function signedIn(): Promise<boolean> {
    return (await passport.credential().catch(() => undefined)) !== undefined
  }

  function logout() {
    api.ui.dialog.replace(() => (
      <api.ui.DialogConfirm
        title={t("tui.phone.logout.title")}
        message={t("tui.phone.logout.message")}
        onConfirm={async () => {
          api.ui.dialog.clear()
          api.kv.set(ENABLED, false)
          await phone.connector.stop()
          const result = await passport.signOut()
          account = undefined
          nickname = undefined
          api.ui.toast({
            message: t(result.connect && result.account ? "tui.phone.logout.done" : "tui.phone.logout.done_local"),
            variant: result.connect && result.account ? "success" : "warning",
          })
        }}
        onCancel={() => void menu()}
      />
    ))
  }

  /** `note` is the outcome of the last action on this page, shown with the details. */
  async function showStatus(note?: string) {
    const credential = await passport.credential().catch(() => undefined)
    if (!credential) {
      void menu()
      return
    }
    const [eligibility, storage, platform] = await Promise.all([
      passport.eligibility(),
      phone.account.secrets.kind(),
      platformUserIds(),
    ])
    const current = (await passport.credential().catch(() => undefined)) ?? credential
    const lines = [
      t("tui.phone.status.account", { name: account?.name ?? "-", user: maskUser(current.userId) }),
      t("tui.phone.status.obtained", { time: new Date(current.obtainedAt).toLocaleString() }),
      t("tui.phone.status.valid_until", { time: new Date(current.obtainedAt + SERVICE_TOKEN_LIFETIME_MS).toLocaleString() }),
      t(`tui.phone.status.connect.${eligibility.kind}`),
      t(`tui.phone.status.storage.${storage}`),
      ...(platform.length && !platform.includes(current.userId) ? [t("tui.phone.login.other_account")] : []),
      ...(note ? ["", note] : []),
    ]
    // The details go in the hint: disabled options are not shown by the select at all.
    api.ui.dialog.replace(() => (
      <DialogSelect
        title={t("tui.phone.status.title")}
        hint={lines.join("\n")}
        skipFilter
        options={[
          { title: t("tui.phone.status.renew"), value: "renew", description: t("tui.phone.status.renew.description") },
          { title: t("tui.phone.status.back"), value: "back" },
        ]}
        onSelect={async (option) => {
          if (option.value === "back") {
            void menu()
            return
          }
          // The outcome is shown in this dialog: a toast under an open dialog is drawn beneath it.
          const outcome = await passport.renew()
          const result = t(`tui.phone.status.renewed.${outcome}`)
          if (outcome === "signed_out") {
            account = undefined
            api.ui.dialog.replace(() => (
              <api.ui.DialogAlert title={t("tui.phone.status.title")} message={result} onConfirm={() => void menu()} />
            ))
            return
          }
          void showStatus(`${result} (${new Date().toLocaleTimeString()})`)
        }}
      />
    ))
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

  async function menu() {
    account = await readAccount()
    api.ui.dialog.replace(() => <Menu api={api} status={status()} account={account} actions={actions} />)
  }

  const start = () => {
    api.kv.set(ENABLED, true)
    void phone.connector.start()
  }

  const actions: MenuActions = {
    on: async () => {
      api.ui.dialog.clear()
      if (await signedIn()) start()
      else void login(start)
    },
    login: () => void login(),
    status: () => void showStatus(),
    logout: () => logout(),
    off: () => {
      api.kv.set(ENABLED, false)
      api.ui.dialog.clear()
      void phone.connector.stop()
    },
    pair: async () => {
      api.ui.dialog.clear()
      if (await signedIn()) void pair()
      else void login(() => void pair())
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
          onCancel={() => void menu()}
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
        onSelect: () => void menu(),
      },
    ]
  })
}

type MenuActions = {
  on: () => void
  off: () => void
  pair: () => void
  login: () => void
  status: () => void
  logout: () => void
  remove: (phone: PhoneStatus) => void
}

type MenuValue = "on" | "off" | "pair" | "login" | "status" | "logout" | { remove: PhoneStatus }

function Menu(props: {
  api: TuiPluginApi
  status: ConnectorStatus
  account: { userId: string; name?: string } | undefined
  actions: MenuActions
}) {
  const t = useLanguage().t
  const status = props.status
  const running = status.state === "online" || status.state === "reconnecting" || status.state === "starting"
  const phones = "phones" in status ? status.phones : []
  const account = props.account
  const accountOptions = account
    ? [
        {
          title: t("tui.phone.action.status"),
          value: "status" as MenuValue,
          description: t("tui.phone.action.status.description"),
          category: t("tui.phone.account"),
        },
        {
          title: t("tui.phone.action.logout"),
          value: "logout" as MenuValue,
          description: t("tui.phone.action.logout.description"),
          category: t("tui.phone.account"),
        },
      ]
    : [
        {
          title: t("tui.phone.action.login"),
          value: "login" as MenuValue,
          description: t("tui.phone.action.login.description"),
        },
      ]
  const options = [
    ...(account ? [] : accountOptions),
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
    ...(account ? accountOptions : []),
  ]
  const state = t(`tui.phone.state.${status.state}`)
  return (
    <props.api.ui.DialogSelect
      title={
        account
          ? t("tui.phone.title.account", { state, name: account.name ?? maskUser(account.userId) })
          : t("tui.phone.title", { state: `${state} · ${t("tui.phone.signed_out")}` })
      }
      options={options}
      onSelect={(option) => {
        const value = option.value
        if (value === "on") return props.actions.on()
        if (value === "off") return props.actions.off()
        if (value === "pair") return props.actions.pair()
        if (value === "login") return props.actions.login()
        if (value === "status") return props.actions.status()
        if (value === "logout") return props.actions.logout()
        props.actions.remove(value.remove)
      }}
    />
  )
}

/** The login URL, its QR code and the time left; closing it cancels the login. */
function LoginDialog(props: { api: TuiPluginApi; attempt: LoginAttempt }) {
  const t = useLanguage().t
  const [now, setNow] = createSignal(Date.now())
  const [copied, setCopied] = createSignal(false)
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const qr = qrBlocks(props.attempt.loginUrl)
  const dimensions = useTerminalDimensions()
  /** A cut-off QR code does not scan: draw it only when the terminal is tall enough for all of it. */
  const qrFits = () => dimensions().height >= qr.split("\n").length + QR_SURROUNDING_ROWS
  const left = () => {
    const seconds = Math.max(0, Math.round((props.attempt.expiresAt - now()) / 1000))
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }
  const copy = () =>
    Clipboard.copy(props.attempt.loginUrl)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => {})
  return (
    <props.api.ui.DialogPrompt
      title={t("tui.phone.login.title")}
      placeholder={t("tui.phone.login.placeholder")}
      description={() => (
        <box gap={1}>
          <text>{t("tui.phone.login.hint")}</text>
          <text fg="#3b82f6" onMouseUp={copy}>
            {props.attempt.loginUrl}
          </text>
          <text>{copied() ? t("tui.phone.login.copied") : t("tui.phone.login.copy_hint")}</text>
          <text>{t("tui.phone.login.waiting", { left: left() })}</text>
          <Show when={qrFits()} fallback={<text>{t("tui.phone.login.qr_too_small")}</text>}>
            <text fg="#000000" bg="#ffffff">
              {qr}
            </text>
          </Show>
        </box>
      )}
      onConfirm={() => {}}
    />
  )
}

/** Rows the login dialog needs besides the QR code (dialog offset, texts, input). */
const QR_SURROUNDING_ROWS = 22

/** A graphical session where opening a browser lands in front of the user. */
function canOpenBrowser(): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false
  if (process.platform === "linux") return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  return true
}

/** A user id shown without its middle digits. */
function maskUser(userId: string): string {
  return userId.length > 4 ? `${userId.slice(0, 2)}***${userId.slice(-2)}` : userId
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
