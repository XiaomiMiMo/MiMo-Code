// Wiring of the phone connector inside the MiMo Code TUI process: the engine
// backend over the TUI's own SDK client and event stream, system protected
// storage, the connector state under the data directory and the sign-in.

import { Connector, PassportAccount, credentialDigest, systemSecretStore, type ConnectorHost } from "@mimo-ai/connector"
import type { OpencodeClient } from "@mimo-ai/sdk/v2"
import os from "node:os"
import path from "node:path"
import { Global } from "@/global"
import { MimoBackend, type EngineEvents } from "./backend"
import { engineFrom } from "./engine"
import {
  DEBUG_IDENTITY_ENV,
  PASSPORT_CREDENTIAL_ENV,
  loadDebugIdentity,
  readPassportCredential,
  type IdentityProblem,
} from "./identity"

const SERVICE = "mimocode-phone"

export type PhoneConnector = {
  connector: Connector
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
  const directory = path.join(Global.Path.data, "phone")
  const secrets = systemSecretStore({ service: SERVICE, directory: path.join(directory, "secrets") })
  const passport = new PassportAccount(secrets)
  const debugIdentity = () => loadDebugIdentity(process.env[DEBUG_IDENTITY_ENV])
  let fileProblem: IdentityProblem | undefined
  /** Import the named credential file into protected storage when it holds another credential. */
  const importCredential = async () => {
    const file = process.env[PASSPORT_CREDENTIAL_ENV]
    if (!file) return
    const credential = await readPassportCredential(file)
    fileProblem = typeof credential === "string" ? credential : undefined
    if (typeof credential === "string") return
    const digest = await credentialDigest(credential)
    if ((await passport.digest().catch(() => undefined)) === digest) return
    await passport.save(credential)
  }
  const account = async () => {
    await importCredential()
    const signedIn = await passport.account()
    if (signedIn) return signedIn
    const debug = await debugIdentity()
    return typeof debug === "string" ? undefined : debug
  }
  const connector = new Connector({
    backend,
    secrets,
    stateFile: path.join(directory, "connector.state"),
    account,
    client: { version: input.version, platform: platform() },
    name: deviceName(),
    host: input.host,
  })
  return {
    connector,
    async identityProblem() {
      if (process.env[PASSPORT_CREDENTIAL_ENV]) return fileProblem
      const debug = await debugIdentity()
      return typeof debug === "string" ? debug : undefined
    },
    async dispose() {
      await connector.stop()
      backend.dispose()
    },
  }
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
