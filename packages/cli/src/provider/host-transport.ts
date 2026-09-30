/** Optional in-process embedding port. No application policy lives in the engine. */
export interface ModelCallScope {
  sessionID: string
  userMessageID: string
  assistantMessageID?: string
  providerID: string
  modelID: string
  sdk: string
  agent: string
  ephemeral: boolean
  format?: string
}

export interface HostTransport {
  userMessage(input: { sessionID: string; userMessageID: string; parts: readonly unknown[] }): void
  modelCall<T>(scope: ModelCallScope, call: () => Promise<T>): Promise<T>
  request?(input: unknown, init: unknown, forward: () => Promise<Response>): Promise<Response>
}

let host: HostTransport | undefined
export function set(value: HostTransport | undefined) { host = value }
export function userMessage(input: Parameters<HostTransport["userMessage"]>[0]) { host?.userMessage(input) }
export function modelCall<T>(scope: ModelCallScope, call: () => Promise<T>): Promise<T> {
  return host ? host.modelCall(scope, call) : call()
}
export function request(input: unknown, init: unknown, forward: () => Promise<Response>): Promise<Response> {
  return host?.request ? host.request(input, init, forward) : forward()
}
export * as HostModelTransport from "./host-transport"
