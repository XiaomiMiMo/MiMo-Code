// Wiring of the phone connector inside the MiMo Code TUI process: the engine
// backend over the TUI's own SDK client and event stream, system protected
// storage, the connector state under the data directory and the sign-in.

import { Connector, SignedInAccount, systemSecretStore, type ConnectorHost } from "@mimo-ai/connector"
import type { OpencodeClient } from "@mimo-ai/sdk/v2"
import os from "node:os"
import path from "node:path"
import { Global } from "@/global"
import { MimoBackend, type EngineEvents } from "./backend"
import { engineFrom } from "./engine"
import {
  ACCOUNT_SESSION_ENV,
  DEBUG_IDENTITY_ENV,
  loadDebugIdentity,
  readAccountSession,
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
  const signedIn = new SignedInAccount({ secrets, clientVersion: releaseVersion(input.version) })
  const debugIdentity = () => loadDebugIdentity(process.env[DEBUG_IDENTITY_ENV])
  let handoffProblem: IdentityProblem | undefined
  const imported = new Set<string>()
  /** A handed-over session is imported once; a stored session it already became is never replaced by the stale file. */
  const importHandoff = async () => {
    const file = process.env[ACCOUNT_SESSION_ENV]
    if (!file) return
    const session = await readAccountSession(file)
    handoffProblem = typeof session === "string" ? session : undefined
    if (typeof session === "string" || imported.has(session.accountSessionId)) return
    imported.add(session.accountSessionId)
    if ((await signedIn.sessionId().catch(() => undefined)) === session.accountSessionId) return
    await signedIn.save(session)
  }
  const account = async () => {
    await importHandoff()
    const session = await signedIn.account()
    if (session) return session
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
      if (process.env[ACCOUNT_SESSION_ENV]) return handoffProblem
      const debug = await debugIdentity()
      return typeof debug === "string" ? debug : undefined
    },
    async dispose() {
      await connector.stop()
      backend.dispose()
    },
  }
}

/** The account service requires a release semver; development builds report 0.0.0. */
function releaseVersion(version: string): string {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : "0.0.0"
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
