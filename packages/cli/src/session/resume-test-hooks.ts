import { Effect } from "effect"

/**
 * Deterministic race seams for trailing-user resume tests.
 * Production leaves these undefined (no-ops). Tests install barriers to stop
 * work after runner occupy and before admission re-check / step-0 parent lock.
 */
export const ResumeTestHooks = {
  /** After runner occupy (start/ensureExclusive), before user-resume admission re-check. */
  beforeAdmissionRecheck: undefined as undefined | (() => Effect.Effect<void>),
  /** [C003] After admission re-check / handshake, before any residue cleanup read. */
  afterAdmissionBeforeCleanup: undefined as undefined | (() => Effect.Effect<void>),
  /** After inbox.drain on step-0, before parent-tail lock checks. */
  beforeStep0ParentCheck: undefined as undefined | (() => Effect.Effect<void>),
  /** After successful planResume, before launchResume exclusive occupy (ensureExclusive/start). */
  beforeExclusiveOccupy: undefined as undefined | (() => Effect.Effect<void>),
  /** [R004] After planResume succeeds, receives the resolved plan so tests can assert the actual target. */
  onPlanResolved: undefined as undefined | ((plan: { action: string; assistantMessageID?: string; parentMessageID?: string }) => void),
  reset() {
    this.beforeAdmissionRecheck = undefined
    this.afterAdmissionBeforeCleanup = undefined
    this.beforeStep0ParentCheck = undefined
    this.beforeExclusiveOccupy = undefined
    this.onPlanResolved = undefined
  },
}
