import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten-core"
// Singlefile variant inlines the wasm as base64 — no sidecar .wasm to ship,
// so `bun build --compile` produces a self-contained binary. Sidecar variants
// (the default `quickjs-emscripten` package) break under --compile because
// emscripten reads the wasm via __dirname at runtime and Bun's bunfs can't
// see that import.
import singlefileVariant from "@jitl/quickjs-singlefile-mjs-release-sync"

/** An injected host function: receives already-marshaled JS args, returns a JS value or Promise. */
export type HostFn = (...args: unknown[]) => unknown | Promise<unknown>

export type SandboxOptions = {
  /** Wall-clock budget for the whole script; default 12h. */
  deadlineMs?: number
  /** Memory cap in bytes; default 64 MiB. */
  memoryLimitBytes?: number
  /** JSON value injected into the guest as the global `args`. */
  args?: unknown
  /** Seed for the in-guest Math.random PRNG. Same seed ⇒ identical sequence
   * (required for resume replay). Different seeds ⇒ different sequences (so
   * sampling-style scripts get fresh coverage across unrelated runs). The
   * runtime passes a hash of runID so resume gets the same seed naturally;
   * tests / one-off callers that don't care can omit this. */
  seed?: number
  /** Default true: strip Date/Math.random/WeakRef for resume-replay determinism
   * (the workflow contract). Pass false for single-shot callers (tool_script)
   * that have no replay requirement and want the standard JS environment. */
  deterministic?: boolean
  /** Optional ACTIVE-time budget: counts only time when NO host hook promise is
   * pending, so a guest parked on a slow tool call is not charged. Kills runaway
   * synchronous guest code via the interrupt handler. Wall-clock `deadlineMs`
   * remains the overall kill-switch for hangs. */
  activeDeadlineMs?: number
  /** Optional cooperative cancel: polled from the interrupt handler (guest
   * bytecode) so an aborted caller can stop a busy guest promptly. */
  interrupt?: () => boolean
}

const DEFAULT_DEADLINE_MS = 12 * 60 * 60 * 1000
const DEFAULT_MEMORY = 64 * 1024 * 1024

/** Guest rejection values dump as {name, message, stack} objects — render them
 * like a normal Error string instead of leaking a JSON blob into the message. */
function formatGuestError(err: unknown): string {
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "message" in err) {
    const e = err as { name?: string; message: string; stack?: string }
    const head = e.name && e.name !== "Error" ? `${e.name}: ${e.message}` : String(e.message)
    return e.stack ? `${head}\n${e.stack.trimEnd()}` : head
  }
  return JSON.stringify(err)
}
/** Fallback seed when no caller-supplied seed is set. Stable so the existing
 * single-shot tests stay deterministic. The runtime always passes seed=hash(runID)
 * so production paths never see this default. */
const DEFAULT_PRNG_SEED = 0x9e3779b9

// Pure-guest helpers. parallel/pipeline do NO throttling — concurrency is
// enforced by the host semaphore inside the agent() hook. They also do NOT
// catch: a throwing thunk/stage rejects the batch (fails loud with the guest
// stack). agent() is never-throw for agent failures (returns null), so the
// only throws reaching here are script-logic errors, which SHOULD fail loud
// rather than become silent nulls that poison downstream .map/.filter.
const PRELUDE = `
globalThis.parallel = (thunks) =>
  Promise.all(thunks.map((t) => Promise.resolve().then(t)));
globalThis.pipeline = (items, ...stages) =>
  Promise.all(items.map((item, index) =>
    stages.reduce((acc, stage) => acc.then((prev) => stage(prev, item, index)), Promise.resolve(item))));
// Minimal, deterministic URL for dedup/host-extraction in workflow scripts.
// The bare QuickJS guest has no Web URL. Covers protocol/hostname/pathname/
// search/hash — enough for normURL-style dedup — and THROWS on inputs without
// a scheme+host, so scripts' try/catch fallbacks behave like the real URL.
globalThis.URL = class URL {
  constructor(input) {
    const str = String(input);
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(str);
    if (!m) throw new TypeError("Invalid URL: " + str);
    this.protocol = m[1].toLowerCase();
    this.hostname = m[2];
    this.pathname = m[3] || "/";
    this.search = m[4] || "";
    this.hash = m[5] || "";
    this.host = m[2];
  }
  toString() { return this.protocol + "//" + this.host + this.pathname + this.search + this.hash; }
};
`

/**
 * Run a workflow script body inside an isolated quickjs-emscripten context.
 * Pure Promise boundary — knows nothing of Effect or actors. `hooks` are host
 * functions injected as guest globals. Returns the script's resolved value
 * (dumped out of the guest by value).
 *
 * Hard constraints encapsulated here (validated by the 2026-06-01 spike):
 *  - sync-promise bridge (newPromise + executePendingJobs), NOT asyncify
 *  - a concurrent pump alongside resolvePromise so host-promises settle
 *  - every QuickJSHandle disposed before context dispose (else process abort)
 */
export async function evalScript(body: string, hooks: Record<string, HostFn>, opts: SandboxOptions = {}): Promise<unknown> {
  const QuickJS = await newQuickJSWASMModuleFromVariant(singlefileVariant)
  const rt = QuickJS.newRuntime()
  rt.setMemoryLimit(opts.memoryLimitBytes ?? DEFAULT_MEMORY)
  // Active-time accounting: charge the guest only while no host hook promise is
  // pending. `pending` transitions drive a pause/resume clock; the interrupt
  // handler (fires only during guest bytecode execution) compares accumulated
  // active time against the budget. Wall-clock deadline still backstops hangs.
  const activeBudget = opts.activeDeadlineMs
  let pending = 0
  let activeStart = Date.now()
  let activeAccum = 0
  const hostCallTracker =
    activeBudget === undefined
      ? undefined
      : {
          start: () => {
            pending++
            if (pending === 1) activeAccum += Date.now() - activeStart
          },
          end: () => {
            pending--
            if (pending === 0) activeStart = Date.now()
          },
        }
  const wallDeadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS)
  rt.setInterruptHandler(() => {
    if (opts.interrupt?.()) return true
    if (Date.now() > wallDeadline) return true
    if (activeBudget === undefined) return false
    const active = activeAccum + (pending === 0 ? Date.now() - activeStart : 0)
    return active > activeBudget
  })
  const vm = rt.newContext()

  // Arena: every handle we create goes here and is disposed in `finally`.
  const arena: QuickJSHandle[] = []
  // Deferreds for async hooks: tracked so an UNSETTLED one (script returned
  // while a host-promise is still in flight) is still disposed before context
  // dispose — otherwise vm.dispose() hard-aborts on the live GC object.
  const deferreds: QuickJSDeferredPromise[] = []
  const track = <H extends QuickJSHandle>(h: H): H => {
    arena.push(h)
    return h
  }

  try {
    injectHooks(vm, hooks, track, deferreds, hostCallTracker)
    // Determinism: the guest is a bare quickjs-emscripten JS engine — no Web/Node
    // APIs exist (no crypto/performance/fetch/timers/process/Temporal/gc; all
    // already undefined). We neutralize the JS built-ins whose output or timing is
    // nondeterministic so resume replay stays sound:
    //   - Date — deleted (nondeterministic wall-clock; scripts must not depend on it).
    //   - Math.random — REPLACED with a SEEDED PRNG keyed on the run's seed (the
    //     runtime passes a hash of runID, so a resume of the SAME run gets the SAME
    //     sequence — the replay-correctness invariant — and two UNRELATED runs of
    //     the same script get DIFFERENT sequences — so sampling-style scripts
    //     (e.g. lifetime-classify's verification sample) get fresh coverage across
    //     runs instead of repeating the same picks. The fallback DEFAULT_PRNG_SEED
    //     is only used by tests/one-off callers that don't pass a seed.
    //   - WeakRef / FinalizationRegistry — deleted (expose GC liveness/callback
    //     scheduling, which differs across runs and would silently diverge on replay).
    // Skipped entirely when deterministic === false (single-shot callers with no
    // replay contract keep the stock JS environment: real Date, real Math.random).
    if (opts.deterministic !== false) {
      const seed = (opts.seed ?? DEFAULT_PRNG_SEED) >>> 0
      const strip = vm.evalCode(`
      delete globalThis.Date;
      (function () {
        // mulberry32 — tiny seeded PRNG; deterministic for a given seed.
        let s = ${seed} >>> 0;
        Math.random = function () {
          s = (s + 0x6d2b79f5) >>> 0;
          let t = s;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      })();
      delete globalThis.WeakRef;
      delete globalThis.FinalizationRegistry;
    `)
      if (strip.error) {
        strip.error.dispose()
      } else {
        strip.value.dispose()
      }
    }
    const pre = vm.evalCode(PRELUDE)
    if (pre.error) {
      const err = vm.dump(pre.error)
      pre.error.dispose()
      throw new Error(`workflow prelude error: ${typeof err === "string" ? err : JSON.stringify(err)}`)
    }
    pre.value.dispose()
    // Inject args as a guest global (by value).
    const argsHandle = marshalIn(vm, opts.args ?? null)
    vm.setProp(vm.global, "args", argsHandle)
    argsHandle.dispose()
    const wrapped = `(async () => {\n${body}\n})()`
    const evalRes = vm.evalCode(wrapped)
    if (evalRes.error) {
      const err = vm.dump(evalRes.error)
      evalRes.error.dispose()
      throw new Error(`workflow script error: ${formatGuestError(err)}`)
    }
    const promiseHandle = track(evalRes.value)
    // Concurrent pump: a BACKSTOP that drains guest microtasks while we await
    // the guest promise. NOTE: agent() results do NOT depend on this loop's
    // latency — injectHooks already calls executePendingJobs() synchronously the
    // moment a host promise settles (resolve/reject/settled below). This pump
    // only catches guest-INTERNAL pending jobs (e.g. a parallel() Promise.all
    // advancing between host settles).
    //
    // Adaptive cadence to avoid idle CPU churn: a guest parked for minutes on a
    // slow agent() has no pending jobs, so a fixed 1ms interval would burn 1000
    // wakeups/sec for nothing. Instead we self-reschedule: stay FAST right after
    // finding work, and back off to SLOW once the guest has been idle for a
    // window. idleTicks resets to 0 whenever work is found, so a busy guest
    // stays at FAST_MS the whole time; a truly-parked guest decays to SLOW_MS.
    // This NEVER stops polling, so it cannot deadlock — worst case it adds
    // <=SLOW_MS latency to a guest-internal chain that wakes during an idle gap.
    const FAST_MS = 1
    const SLOW_MS = 50
    const FAST_WINDOW = 50
    let pumpTimer: ReturnType<typeof setTimeout> | undefined
    let idleTicks = 0
    const pumpOnce = () => {
      if (rt.hasPendingJob()) {
        rt.executePendingJobs()
        idleTicks = 0
      } else {
        idleTicks++
      }
      pumpTimer = setTimeout(pumpOnce, idleTicks < FAST_WINDOW ? FAST_MS : SLOW_MS)
    }
    pumpTimer = setTimeout(pumpOnce, FAST_MS)
    // Host-side wall-clock deadline. The runtime interrupt handler above only
    // fires while the guest is executing bytecode, so it kills runaway
    // *synchronous* guest code (e.g. `while(true){}`) — but NOT a guest parked
    // on a pending host promise (a hanging agent() resolves to a host Promise
    // that never settles, leaving the runtime with no pending jobs to interrupt).
    // This timer is the true kill-switch for that case: it races resolvePromise
    // and rejects when the budget elapses. The `finally` below still disposes the
    // unsettled deferred before the context, so no process abort on cleanup.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error("workflow script deadline exceeded")),
        opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
      )
    })
    try {
      const resolved = await Promise.race([vm.resolvePromise(promiseHandle), deadline])
      if (resolved.error) {
        const err = vm.dump(resolved.error)
        resolved.error.dispose()
        throw new Error(`workflow script rejected: ${formatGuestError(err)}`)
      }
      const valueHandle = track(resolved.value)
      return vm.dump(valueHandle)
    } finally {
      clearTimeout(pumpTimer)
      clearTimeout(deadlineTimer)
    }
  } finally {
    // Dispose deferreds BEFORE the arena/context: an unsettled deferred still
    // owns live guest handles, and vm.dispose() aborts the process if any
    // GC object is still alive. Disposing a settled deferred is a no-op.
    for (const d of deferreds) {
      if (d.alive) d.dispose()
    }
    for (const h of arena) {
      if (h.alive) h.dispose()
    }
    vm.dispose()
    rt.dispose()
  }
}

function injectHooks(
  vm: QuickJSContext,
  hooks: Record<string, HostFn>,
  track: <H extends QuickJSHandle>(h: H) => H,
  deferreds: QuickJSDeferredPromise[],
  hostCallTracker?: { start: () => void; end: () => void },
): void {
  for (const [name, fn] of Object.entries(hooks)) {
    const fnHandle = vm.newFunction(name, (...argHandles) => {
      const args = argHandles.map((h) => vm.dump(h))
      const out = fn(...args)
      if (out instanceof Promise) {
        const promise = vm.newPromise()
        deferreds.push(promise)
        hostCallTracker?.start()
        out.then(
          (value) => {
            hostCallTracker?.end()
            // A late settle may arrive after the context is disposed (script
            // returned without awaiting). Bail before touching a dead context.
            if (!vm.alive) return
            const vh = marshalIn(vm, value)
            promise.resolve(vh)
            vh.dispose()
            vm.runtime.executePendingJobs()
          },
          (err) => {
            hostCallTracker?.end()
            if (!vm.alive) return
            const eh = vm.newString(err instanceof Error ? err.message : String(err))
            promise.reject(eh)
            eh.dispose()
            vm.runtime.executePendingJobs()
          },
        )
        promise.settled.then(() => {
          if (vm.alive) vm.runtime.executePendingJobs()
        })
        return promise.handle
      }
      return marshalIn(vm, out)
    })
    vm.setProp(vm.global, name, track(fnHandle))
  }
}

/** Marshal a host JS value INTO the guest (by copy via JSON for structured data). */
function marshalIn(vm: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === undefined || value === null) return vm.undefined
  // newString truncates at the first NUL byte (C-string boundary). Route
  // NUL-containing strings through the JSON path below, where \0 is escaped
  // as the 6-char sequence \u0000 and restored by the guest's JSON.parse.
  if (typeof value === "string" && !value.includes("\0")) return vm.newString(value)
  if (typeof value === "number") return vm.newNumber(value)
  if (typeof value === "boolean") return value ? vm.true : vm.false
  const json = vm.newString(JSON.stringify(value))
  const parseRes = vm.evalCode("JSON.parse")
  const parseFn = vm.unwrapResult(parseRes)
  const out = vm.callFunction(parseFn, vm.undefined, json)
  json.dispose()
  parseFn.dispose()
  return vm.unwrapResult(out)
}
