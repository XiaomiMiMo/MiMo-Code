// The phone connector of one local agent installation.
//
// Lifecycle: sign-in material and a protected store are required up front;
// the installation key is registered once per account; the control socket is
// the online lease and every reconnect starts a new connection generation in
// which each locally confirmed binding gets a fresh grant and device group.
// Pairing always ends with an explicit local decision. Turning the connector
// off only goes offline: bindings stay until the user unpairs.

import { ConnectApi, type BindingView, type GrantView, type Scopes } from "./api"
import { ControlChannel } from "./control"
import { DeviceGroup, type GroupContext } from "./group"
import { ConnectError, ConnectHttp, type AccountSession, type ClientInfo } from "./http"
import { generateDeviceKey, importDeviceKey, type DeviceKey, type PrivateJwk } from "./proof"
import type { AgentBackend, SecretStore } from "./ports"
import { bunDial, type Dial } from "./socket"
import { StateFile, type Consent, type ConnectorState } from "./state"
import { Submissions } from "./submissions"

const KEY_SECRET = "device-key"
const PAIRING_POLL_MS = 2_000
const PENDING_TTL_MS = 10 * 60_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** A generation that stayed up this long resets the reconnect backoff. */
const STABLE_MS = 60_000
const READ_ONLY: Consent["scopes"] = ["sessions:list", "sessions:read"]
const READ_SEND: Consent["scopes"] = ["sessions:list", "sessions:read", "sessions:send"]

export type ConnectorAccount = AccountSession & {
  /** Stable account subject; local consent is only valid for the subject that gave it. */
  subject: string
}

export type UnavailableReason =
  | "secure_storage_unavailable"
  | "not_signed_in"
  | "account_rejected"
  | "service_without_cli"
  | "state_unreadable"
  | "registration_conflict"

export type PhoneStatus = { bindingId: string; phoneName: string; canSend: boolean; connected: boolean }
export type PairingStatus = { code: string; expiresAt: string; phoneName?: string }

export type ConnectorStatus =
  | { state: "off" }
  | { state: "starting" }
  | { state: "unavailable"; reason: UnavailableReason }
  | { state: "reconnecting"; retryInMs: number; phones: PhoneStatus[] }
  | { state: "online"; phones: PhoneStatus[]; pairing?: PairingStatus }

export type PairingOutcome = "approved" | "rejected" | "expired" | "cancelled" | "failed"

export interface ConnectorHost {
  /** Ask the local user whether this phone may connect; undefined rejects it. */
  confirmPairing(request: { phoneName: string; code: string }): Promise<{ canSend: boolean } | undefined>
  status(status: ConnectorStatus): void
}

export type ConnectorOptions = {
  backend: AgentBackend
  secrets: SecretStore
  stateFile: string
  account: () => Promise<ConnectorAccount | undefined>
  client: ClientInfo
  /** Name shown on the phone (1..80 characters). */
  name: string
  host: ConnectorHost
  dial?: Dial
  clock?: () => number
  /** How often a shown pairing code is polled for a claim. */
  pairingPollMs?: number
}

type Generation = {
  control: ControlChannel
  epoch: number
  startedAt: number
  ended: boolean
}

type Runtime = {
  account: ConnectorAccount
  http: ConnectHttp
  api: ConnectApi
  deviceId: string
}

export class Connector {
  private readonly state: StateFile
  private readonly submissions: Submissions
  private readonly dial: Dial
  private readonly clock: () => number
  private runtime: Runtime | undefined
  private generation: Generation | undefined
  private readonly groups = new Map<string, DeviceGroup>()
  /** Bindings whose grant is being published, so concurrent reconciles never race two grants. */
  private readonly exposing = new Set<string>()
  private lastPhones: PhoneStatus[] = []
  private readonly retries = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>()
  private enabled = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempts = 0
  private pairing: { challengeId: string; status: PairingStatus; cancelled: boolean } | undefined
  private current: ConnectorStatus = { state: "off" }

  constructor(private readonly options: ConnectorOptions) {
    this.state = new StateFile(options.stateFile, options.secrets, options.clock)
    this.submissions = new Submissions(options.backend, this.state, options.clock)
    this.dial = options.dial ?? bunDial
    this.clock = options.clock ?? Date.now
  }

  get status(): ConnectorStatus {
    return this.current
  }

  /** Go online. Resolves after the first connection attempt (online, reconnecting or unavailable). */
  async start(): Promise<void> {
    if (this.enabled) return
    this.enabled = true
    this.publish({ state: "starting" })
    await this.boot()
  }

  private async boot(): Promise<void> {
    if (!this.enabled) return
    let runtime: Runtime | UnavailableReason
    try {
      runtime = await this.prepare()
    } catch (error) {
      // Service or network trouble before the first connection is retried like a lost connection.
      return this.lost(error)
    }
    if (!this.enabled) return
    if (typeof runtime === "string") {
      this.enabled = false
      return this.publish({ state: "unavailable", reason: runtime })
    }
    this.runtime = runtime
    await this.connect()
  }

  /** Go offline. Bindings and consents are kept; phones see this computer as offline. */
  async stop(): Promise<void> {
    this.enabled = false
    clearTimeout(this.reconnectTimer)
    if (this.pairing) this.pairing.cancelled = true
    this.endGeneration()
    this.runtime = undefined
    this.publish({ state: "off" })
  }

  /**
   * Show a pairing code and wait for a phone to claim it. A claim is only
   * approved after the host's local confirmation.
   */
  async pair(): Promise<PairingOutcome> {
    const runtime = this.runtime
    const generation = this.generation
    if (!runtime || !generation || !this.live(generation) || generation.epoch === 0 || this.pairing) return "failed"
    const challenge = await runtime.api.createPairingCode(generation.epoch).catch(() => undefined)
    if (!challenge) return "failed"
    const pairing = (this.pairing = {
      challengeId: challenge.challengeId,
      status: { code: challenge.code, expiresAt: challenge.expiresAt },
      cancelled: false,
    })
    this.refresh()
    try {
      return await this.awaitClaim(runtime, pairing)
    } finally {
      if (this.pairing === pairing) this.pairing = undefined
      this.refresh()
    }
  }

  /** Withdraw the code being shown. */
  async cancelPairing(): Promise<void> {
    const pairing = this.pairing
    if (!pairing) return
    pairing.cancelled = true
    const epoch = this.generation?.epoch
    if (this.runtime && epoch)
      await this.runtime.api.cancelPairingCode(pairing.challengeId, epoch).catch(() => undefined)
  }

  /** Remove a phone: the binding is revoked on the service and the local consent dropped. */
  async unpair(bindingId: string): Promise<void> {
    const runtime = this.runtime
    if (!runtime) throw new ConnectError("offline")
    await runtime.api.revoke(bindingId)
    // A live group receives the revoked fence and lets the service confirm it;
    // otherwise the next reconnect confirms it with recovery credentials.
    await this.state.update((state) => {
      delete state.consents[bindingId]
    })
    this.refresh()
  }

  // ---- setup ----------------------------------------------------------------

  private async prepare(): Promise<Runtime | UnavailableReason> {
    if (!(await this.options.secrets.available().catch(() => false))) return "secure_storage_unavailable"
    const account = await this.options.account().catch(() => undefined)
    if (!account) return "not_signed_in"
    let state: ConnectorState
    try {
      state = await this.state.read()
    } catch {
      return "state_unreadable"
    }
    const key = await this.deviceKey()
    if (!key) return "secure_storage_unavailable"
    let deviceId: string | undefined
    const installation = state.installation
    if (
      installation &&
      installation.origin === account.origin &&
      installation.environment === account.environment &&
      installation.subject === account.subject
    ) {
      deviceId = installation.deviceId
    }
    const http = new ConnectHttp({ account: () => account, key, deviceId: () => deviceId, client: this.options.client })
    const api = new ConnectApi(http)
    try {
      if (!(await api.offersCliProfile())) return "service_without_cli"
      if (!deviceId) {
        // Registration is idempotent per account and key, so a lost answer is simply repeated.
        const registered = await api.register(this.options.name)
        deviceId = registered.deviceId
        await this.state.update((next) => {
          next.installation = {
            origin: account.origin,
            environment: account.environment,
            subject: account.subject,
            deviceId: registered.deviceId,
          }
        })
      }
    } catch (error) {
      if (error instanceof ConnectError && (error.status === 401 || error.status === 403)) return "account_rejected"
      // This key is already registered for the account under another name.
      if (error instanceof ConnectError && error.code === "conflict") return "registration_conflict"
      throw error
    }
    return { account, http, api, deviceId }
  }

  private async deviceKey(): Promise<DeviceKey | undefined> {
    let stored: string | undefined
    try {
      stored = await this.options.secrets.get(KEY_SECRET)
    } catch {
      // A store that cannot be read must never lead to a replacement key.
      return undefined
    }
    if (stored) return importDeviceKey(JSON.parse(stored) as PrivateJwk)
    const { key, privateJwk } = await generateDeviceKey()
    await this.options.secrets.set(KEY_SECRET, JSON.stringify(privateJwk))
    // Read back: a store that silently drops writes must not leave an unrecoverable key in use.
    return (await this.options.secrets.get(KEY_SECRET)) ? key : undefined
  }

  // ---- connection generations -------------------------------------------------

  private async connect(): Promise<void> {
    const runtime = this.runtime
    if (!this.enabled || !runtime) return
    const generation: Generation = { control: undefined!, epoch: 0, startedAt: this.clock(), ended: false }
    generation.control = new ControlChannel(runtime.http, () => runtime.account.origin, this.dial, {
      onClosed: () => {
        if (this.generation === generation) this.lost()
      },
    })
    this.generation = generation
    try {
      generation.epoch = await generation.control.open()
    } catch (error) {
      if (this.generation === generation) this.lost(error)
      return
    }
    this.refresh()
    await this.reconcile(runtime, generation).catch(() => undefined)
  }

  private lost(error?: unknown): void {
    const generation = this.generation
    const stable = generation && generation.epoch > 0 && this.clock() - generation.startedAt >= STABLE_MS
    this.endGeneration()
    if (!this.enabled) return
    if (stable) this.reconnectAttempts = 0
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.reconnectAttempts)
    const cooldown = error instanceof ConnectError ? (error.retryAfterMs ?? 0) : 0
    const wait = Math.max(backoff, cooldown, this.runtime?.http.cooldownRemainingMs() ?? 0)
    this.reconnectAttempts += 1
    this.publish({ state: "reconnecting", retryInMs: wait, phones: this.lastPhones })
    this.reconnectTimer = setTimeout(() => void (this.runtime ? this.connect() : this.boot()), wait)
  }

  private endGeneration(): void {
    const generation = this.generation
    this.generation = undefined
    for (const retry of this.retries.values()) clearTimeout(retry.timer)
    this.retries.clear()
    for (const group of this.groups.values()) group.close()
    this.groups.clear()
    if (generation && !generation.ended) {
      generation.ended = true
      generation.control.close()
    }
  }

  private live(generation: Generation): boolean {
    return this.enabled && this.generation === generation && !generation.ended
  }

  // ---- bindings ---------------------------------------------------------------

  /** Bring the service's bindings and the local consents into agreement for this generation. */
  private async reconcile(runtime: Runtime, generation: Generation): Promise<void> {
    await this.settlePending(runtime)
    const bindings = await runtime.api.bindings(runtime.deviceId)
    if (!this.live(generation)) return
    const known = new Set(bindings.map(({ binding }) => binding.bindingId))
    const state = await this.state.read()
    for (const { binding } of bindings) {
      const consent = state.consents[binding.bindingId]
      if (binding.state === "active") {
        if (consent && this.consentHolds(consent, runtime.account))
          void this.expose(runtime, generation, binding, consent)
        continue
      }
      const hasGate = Object.keys(state.gates).some((key) => key.startsWith(`${binding.bindingId}:`))
      if (consent || hasGate) await this.confirmRevoked(runtime, generation, binding)
    }
    // Consents for bindings the service no longer lists cannot be exposed again.
    await this.state.update((next) => {
      for (const bindingId of Object.keys(next.consents)) {
        if (!known.has(bindingId) && next.consents[bindingId].subject === runtime.account.subject) {
          delete next.consents[bindingId]
        }
      }
    })
    this.refresh()
  }

  private consentHolds(consent: Consent, account: ConnectorAccount): boolean {
    return consent.subject === account.subject && consent.environment === account.environment
  }

  /** Publish this generation's grant from the stored consent and open a device group for it. */
  private async expose(
    runtime: Runtime,
    generation: Generation,
    binding: BindingView,
    consent: Consent,
  ): Promise<void> {
    if (!this.live(generation) || this.groups.has(binding.bindingId) || this.exposing.has(binding.bindingId)) return
    this.exposing.add(binding.bindingId)
    let grant: GrantView
    try {
      grant = await this.publishGrant(runtime, generation, binding.bindingId, consent.scopes)
    } catch (error) {
      if (error instanceof ConnectError && error.code === "binding_revoked") return void this.forget(binding.bindingId)
      return this.retry(runtime, generation, binding, consent)
    } finally {
      this.exposing.delete(binding.bindingId)
    }
    if (!this.live(generation)) return
    const group = new DeviceGroup(this.groupContext(runtime), grant, (end) => {
      if (this.groups.get(binding.bindingId) !== group) return
      this.groups.delete(binding.bindingId)
      this.refresh()
      if (end.revoked) return void this.forget(binding.bindingId)
      // Grant changes and lane failures rebuild with a fresh grant and group.
      this.retry(runtime, generation, binding, consent)
    })
    this.groups.set(binding.bindingId, group)
    try {
      await group.open()
      this.retries.delete(binding.bindingId)
      this.refresh()
    } catch {
      if (this.groups.get(binding.bindingId) === group) {
        this.groups.delete(binding.bindingId)
        this.retry(runtime, generation, binding, consent)
      }
    }
  }

  private async publishGrant(runtime: Runtime, generation: Generation, bindingId: string, scopes: Scopes) {
    // A conflict means someone (or a lost answer of ours) moved the version: read it again once.
    for (let attempt = 0; ; attempt++) {
      const meta = await runtime.api.upgradeMetadata(bindingId, generation.epoch)
      try {
        return await runtime.api.publishGrant(bindingId, {
          connectionEpoch: generation.epoch,
          expectedVersion: meta.grantVersion,
          state: "active",
          scopes,
        })
      } catch (error) {
        if (attempt === 0 && error instanceof ConnectError && error.code === "conflict") continue
        throw error
      }
    }
  }

  private retry(runtime: Runtime, generation: Generation, binding: BindingView, consent: Consent): void {
    if (!this.live(generation)) return
    const retry = this.retries.get(binding.bindingId) ?? { attempts: 0 }
    clearTimeout(retry.timer)
    const wait = Math.max(
      Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** retry.attempts),
      runtime.http.cooldownRemainingMs(),
    )
    retry.attempts += 1
    retry.timer = setTimeout(() => void this.expose(runtime, generation, binding, consent), wait)
    this.retries.set(binding.bindingId, retry)
  }

  /** Let the service record that this connector stopped serving a revoked binding. */
  private async confirmRevoked(runtime: Runtime, generation: Generation, binding: BindingView): Promise<void> {
    const state = await this.state.read()
    const gate = Object.entries(state.gates).find(([key]) => key.startsWith(`${binding.bindingId}:`))?.[1]
    const grantVersion = await runtime.api
      .grant(binding.bindingId)
      .then((grant) => grant.grantVersion)
      .catch(() => gate?.grantVersion)
    let confirmed = binding.relayFence === "complete"
    if (!confirmed && grantVersion) {
      const recovery = {
        bindingId: binding.bindingId,
        grantVersion,
        connectionEpoch: generation.epoch,
        scopes: [] as Scopes,
      }
      confirmed = await new DeviceGroup(this.groupContext(runtime), recovery, () => {})
        .confirmRevocation()
        .catch(() => false)
    }
    if (confirmed) await this.forget(binding.bindingId)
    else {
      await this.state.update((next) => {
        delete next.consents[binding.bindingId]
      })
    }
  }

  private async forget(bindingId: string): Promise<void> {
    this.groups.get(bindingId)?.close()
    this.groups.delete(bindingId)
    await this.state.update((state) => {
      delete state.consents[bindingId]
      for (const key of Object.keys(state.gates)) if (key.startsWith(`${bindingId}:`)) delete state.gates[key]
    })
    this.refresh()
  }

  private groupContext(runtime: Runtime): GroupContext {
    return {
      api: runtime.api,
      http: runtime.http,
      origin: () => runtime.account.origin,
      dial: this.dial,
      backend: this.options.backend,
      submissions: this.submissions,
      state: this.state,
      clock: this.options.clock,
    }
  }

  // ---- pairing ---------------------------------------------------------------

  private async awaitClaim(
    runtime: Runtime,
    pairing: { challengeId: string; status: PairingStatus; cancelled: boolean },
  ): Promise<PairingOutcome> {
    const expiresAt = Date.parse(pairing.status.expiresAt)
    while (!pairing.cancelled && this.clock() < expiresAt) {
      await Bun.sleep(this.options.pairingPollMs ?? PAIRING_POLL_MS)
      if (pairing.cancelled) break
      const status = await runtime.api.pairingStatus(pairing.challengeId).catch(() => undefined)
      if (!status) continue
      if (status.status === "open") continue
      if (status.status !== "claimed" || !status.request) {
        return status.status === "approved" || status.status === "rejected" || status.status === "cancelled"
          ? status.status
          : "expired"
      }
      pairing.status = { ...pairing.status, phoneName: status.request.phoneName }
      this.refresh()
      return this.decide(runtime, pairing, status.request)
    }
    return pairing.cancelled ? "cancelled" : "expired"
  }

  private async decide(
    runtime: Runtime,
    pairing: { challengeId: string; status: PairingStatus; cancelled: boolean },
    request: { requestId: string; phoneName: string },
  ): Promise<PairingOutcome> {
    const answer = await this.options.host
      .confirmPairing({ phoneName: request.phoneName, code: pairing.status.code })
      .catch(() => undefined)
    const generation = this.generation
    if (!generation || !this.live(generation)) return "failed"
    if (!answer || pairing.cancelled) {
      await runtime.api.decide(request.requestId, "reject", generation.epoch).catch(() => undefined)
      return "rejected"
    }
    // The confirmation is durable before approval, so a crash in between still
    // ends with a consent for the binding the service created.
    await this.state.update((state) => {
      state.pending[request.requestId] = {
        phoneName: request.phoneName,
        subject: runtime.account.subject,
        environment: runtime.account.environment,
        scopes: answer.canSend ? READ_SEND : READ_ONLY,
        confirmedAt: this.clock(),
      }
    })
    const decision = await runtime.api.decide(request.requestId, "approve", generation.epoch).catch(() => undefined)
    await this.settlePending(runtime)
    if (decision?.status !== "approved" || !decision.bindingId) return "failed"
    await this.reconcile(runtime, generation).catch(() => undefined)
    return "approved"
  }

  /** Turn recorded confirmations into consents once their pairing request is decided. */
  private async settlePending(runtime: Runtime): Promise<void> {
    const pending = (await this.state.read()).pending
    for (const [requestId, confirmation] of Object.entries(pending)) {
      const request = await runtime.api.pairingRequest(requestId).catch((error) => {
        // Gone for good: the confirmation can never become a binding.
        if (error instanceof ConnectError && error.status === 404) return null
        return undefined
      })
      if (request === undefined) continue
      // Still undecided: an approval may be in flight. Codes live 5 minutes, so an older one is abandoned.
      const undecided = request && (request.status === "open" || request.status === "claimed")
      if (undecided && this.clock() - confirmation.confirmedAt < PENDING_TTL_MS) continue
      const binding =
        request?.status === "approved" && request.bindingId
          ? await runtime.api.binding(request.bindingId).catch(() => undefined)
          : undefined
      if (request?.status === "approved" && !binding) continue
      await this.state.update((state) => {
        delete state.pending[requestId]
        if (binding)
          state.consents[binding.bindingId] = {
            ...confirmation,
            bindingId: binding.bindingId,
            phoneId: binding.phoneId,
          }
      })
    }
  }

  // ---- status ----------------------------------------------------------------

  private refresh(): void {
    const generation = this.generation
    if (!this.enabled || !generation || generation.epoch === 0) return
    void this.state
      .read()
      .then((state) => {
        if (this.generation !== generation) return
        this.lastPhones = this.phones(state)
        this.publish({
          state: "online",
          phones: this.lastPhones,
          ...(this.pairing ? { pairing: this.pairing.status } : {}),
        })
      })
      .catch(() => undefined)
  }

  private phones(state: ConnectorState | undefined): PhoneStatus[] {
    const consents = state?.consents ?? {}
    const subject = this.runtime?.account.subject
    return Object.values(consents)
      .filter((consent) => consent.subject === subject)
      .map((consent) => ({
        bindingId: consent.bindingId,
        phoneName: consent.phoneName,
        canSend: (consent.scopes as string[]).includes("sessions:send"),
        connected: this.groups.get(consent.bindingId)?.ready ?? false,
      }))
  }

  private publish(status: ConnectorStatus): void {
    this.current = status
    this.options.host.status(status)
  }
}
