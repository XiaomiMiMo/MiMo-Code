// `mimo phone`: the Xiaomi account sign-in of the phone connection without the
// TUI, for SSH sessions and scripts. Same account and storage as `/phone`.

import * as prompts from "@clack/prompts"
import { PassportLoginError, SERVICE_TOKEN_LIFETIME_MS } from "@mimo-ai/connector"
import { InstallationVersion } from "../../installation/version"
import { platformUserIds } from "../../phone/identity"
import { qrAnsi } from "../../phone/qr"
import { createPhoneAccount } from "../../phone/runtime"
import { t } from "../i18n"
import { UI } from "../ui"
import { cmd } from "./cmd"

export const PhoneCommand = cmd({
  command: "phone",
  describe: "sign in with a Xiaomi account to connect phones",
  builder: (yargs) => yargs.command(PhoneLoginCommand).command(PhoneStatusCommand).command(PhoneLogoutCommand).demandCommand(),
  async handler() {},
})

export const PhoneLoginCommand = cmd({
  command: "login",
  describe: "sign in with a Xiaomi account (opens nothing; shows an address and a QR code)",
  async handler() {
    UI.empty()
    prompts.intro(t("cli.phone.login.intro"))
    const { passport, secrets } = createPhoneAccount(InstallationVersion)
    let attempt
    try {
      attempt = await passport.signIn()
    } catch {
      prompts.log.error(t("cli.phone.login.start_failed"))
      process.exitCode = 1
      return
    }
    prompts.log.info(t("cli.phone.login.hint"))
    prompts.log.message(attempt.loginUrl)
    process.stdout.write(`${qrAnsi(attempt.loginUrl)}\n`)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.once("SIGINT", cancel)
    const spinner = prompts.spinner()
    spinner.start(t("cli.phone.login.waiting"))
    try {
      const tokens = await attempt.wait(controller.signal)
      const name = (await passport.nickname()) ?? maskUser(tokens.userId)
      spinner.stop(t("cli.phone.login.done", { name }))
      const platform = await platformUserIds()
      if (platform.length && !platform.includes(tokens.userId)) prompts.log.warn(t("cli.phone.other_account"))
      if ((await secrets.kind()) === "file") prompts.log.warn(t("cli.phone.storage_file"))
      prompts.outro(t("cli.phone.login.next"))
    } catch (error) {
      const code = error instanceof PassportLoginError ? error.code : "network"
      spinner.stop(t(`cli.phone.login.failed.${code}`), 1)
      process.exitCode = 1
    } finally {
      process.off("SIGINT", cancel)
    }
  },
})

export const PhoneStatusCommand = cmd({
  command: "status",
  describe: "show the Xiaomi account of the phone connection",
  async handler() {
    UI.empty()
    const { passport, secrets } = createPhoneAccount(InstallationVersion)
    const credential = await passport.credential()
    if (!credential) {
      prompts.log.info(t("cli.phone.status.signed_out"))
      return
    }
    const [eligibility, storage, name, platform] = await Promise.all([
      passport.eligibility(),
      secrets.kind(),
      passport.nickname(),
      platformUserIds(),
    ])
    const current = (await passport.credential()) ?? credential
    prompts.intro(t("cli.phone.status.title"))
    prompts.log.info(t("cli.phone.status.account", { name: name ?? "-", user: maskUser(current.userId) }))
    prompts.log.info(t("cli.phone.status.valid_until", { time: new Date(current.obtainedAt + SERVICE_TOKEN_LIFETIME_MS).toLocaleString() }))
    prompts.log.info(t(`cli.phone.status.connect.${eligibility.kind}`))
    prompts.log.info(t(`cli.phone.status.storage.${storage}`))
    if (platform.length && !platform.includes(current.userId)) prompts.log.warn(t("cli.phone.other_account"))
    prompts.outro("")
  },
})

export const PhoneLogoutCommand = cmd({
  command: "logout",
  describe: "sign the phone connection out of the Xiaomi account",
  async handler() {
    UI.empty()
    const { passport } = createPhoneAccount(InstallationVersion)
    if (!(await passport.credential())) {
      prompts.log.info(t("cli.phone.status.signed_out"))
      return
    }
    const result = await passport.signOut()
    if (result.connect && result.account) prompts.log.success(t("cli.phone.logout.done"))
    else prompts.log.warn(t("cli.phone.logout.done_local"))
  },
})

/** A user id shown without its middle digits. */
function maskUser(userId: string): string {
  return userId.length > 4 ? `${userId.slice(0, 2)}***${userId.slice(-2)}` : userId
}
