// Wiring of the phone connector inside MiMo Code: the engine backend over the
// TUI's own SDK client and event stream, the secret store, the connector state
// under the data directory and the Xiaomi account sign-in.

import {
  CHINA_PRODUCTION,
  Connector,
  PassportAccount,
  PassportClient,
  fileSecretStore,
  protectedOrFileStore,
  systemSecretStore,
  type ClientInfo,
  type ConnectorHost,
  type ResolvedSecretStore,
} from "@mimo-ai/connector"
import type { OpencodeClient } from "@mimo-ai/sdk/v2"
import os from "node:os"
import path from "node:path"
import { Global } from "@/global"
import { MimoBackend, type EngineEvents } from "./backend"
import { engineFrom } from "./engine"
import { DEBUG_IDENTITY_ENV, loadDebugIdentity, type IdentityProblem } from "./identity"

const SERVICE = "mimocode-phone"

/** The Xiaomi account of the phone connection and where its secrets live. */
export type PhoneAccount = {
  passport: PassportAccount
  secrets: ResolvedSecretStore
}

/** Shared by the TUI and `mimo phone`: one account, one secret store per install. */
export function createPhoneAccount(version: string): PhoneAccount {
  const directory = phoneDirectory()
  const secrets = protectedOrFileStore(
    systemSecretStore({ service: SERVICE, directory: path.join(directory, "secrets") }),
    fileSecretStore(path.join(directory, "secrets-file")),
  )
  const passport = new PassportAccount(secrets, {
    client: new PassportClient({ service: CHINA_PRODUCTION, userAgent: `MiMoCode/${version}` }),
    info: clientInfo(version),
  })
  return { passport, secrets }
}

export type PhoneConnector = {
  connector: Connector
  account: PhoneAccount
  /** Why there is no account to sign in with, if there is none. */
  identityProblem(): Promise<IdentityProblem | undefined>
  dispose(): Promise<void>
}

export function createPhoneConnector(input: {
  client: () => OpencodeClient
  events: EngineEvents
  version: string
  host: ConnectorHost
}): PhoneConnector {
  const backend = new MimoBackend(engineFrom(input.client), input.events)
  const account = createPhoneAccount(input.version)
  const { passport, secrets } = account
  const debugIdentity = () => loadDebugIdentity(process.env[DEBUG_IDENTITY_ENV])
  const signedIn = async () => {
    const own = await passport.account()
    if (own) return own
    if (!process.env[DEBUG_IDENTITY_ENV]) return undefined
    const debug = await debugIdentity()
    return typeof debug === "string" ? undefined : debug
  }
  /** The serviceToken a rejection was already answered for: renew once, never loop. */
  let renewedAfter: string | undefined
  const connector: Connector = new Connector({
    backend,
    secrets,
    stateFile: path.join(phoneDirectory(), "connector.state"),
    account: signedIn,
    client: clientInfo(input.version),
    name: deviceName(),
    host: {
      confirmPairing: (request) => input.host.confirmPairing(request),
      status: (next) => {
        input.host.status(next)
        // Connect no longer accepts the serviceToken (ended early, or older than the
        // service allows): take a fresh one from the passToken and start again.
        if (next.state === "unavailable" && next.reason === "account_rejected") void recover()
      },
    },
  })
  const recover = async () => {
    const credential = await passport.credential()
    if (!credential || renewedAfter === credential.serviceToken) return
    renewedAfter = credential.serviceToken
    if ((await passport.renew()) === "renewed") await connector.start()
  }
  return {
    connector,
    account,
    async identityProblem() {
      if (passport.signInEnded()) return "expired"
      if (!process.env[DEBUG_IDENTITY_ENV]) return undefined
      const debug = await debugIdentity()
      return typeof debug === "string" ? debug : undefined
    },
    async dispose() {
      await connector.stop()
      backend.dispose()
    },
  }
}

function phoneDirectory(): string {
  return path.join(Global.Path.data, "phone")
}

function clientInfo(version: string): ClientInfo {
  return { version, platform: platform() }
}

function platform(): "macos" | "windows" | "linux" {
  if (process.platform === "darwin") return "macos"
  if (process.platform === "win32") return "windows"
  return "linux"
}

/** How the phone lists this computer; at most 80 characters, no control characters. */
export function deviceName(hostname = os.hostname()): string {
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const host = [...hostname.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim()].slice(0, 64).join("")
  return host ? `MiMo Code (${host})` : "MiMo Code"
}
