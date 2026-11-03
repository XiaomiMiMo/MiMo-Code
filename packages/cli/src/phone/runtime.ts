// Wiring of the phone connector inside the MiMo Code TUI process: the engine
// backend over the TUI's own SDK client and event stream, system protected
// storage, the connector state under the data directory and the sign-in.

import { Connector, systemSecretStore, type ConnectorHost } from "@mimo-ai/connector"
import type { OpencodeClient } from "@mimo-ai/sdk/v2"
import os from "node:os"
import path from "node:path"
import { Global } from "@/global"
import { MimoBackend, type EngineEvents } from "./backend"
import { engineFrom } from "./engine"
import { DEBUG_IDENTITY_ENV, loadDebugIdentity, type IdentityProblem } from "./identity"

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
  const identity = () => loadDebugIdentity(process.env[DEBUG_IDENTITY_ENV])
  const connector = new Connector({
    backend,
    secrets: systemSecretStore({ service: SERVICE, directory: path.join(directory, "secrets") }),
    stateFile: path.join(directory, "connector.state"),
    account: async () => {
      const account = await identity()
      return typeof account === "string" ? undefined : account
    },
    client: { version: input.version, platform: platform() },
    name: deviceName(),
    host: input.host,
  })
  return {
    connector,
    async identityProblem() {
      const account = await identity()
      return typeof account === "string" ? account : undefined
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
