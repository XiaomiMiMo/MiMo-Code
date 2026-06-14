import { Effect } from "effect"
import { FileWatcher } from "@/file/watcher"
import { Bus } from "@/bus"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"

const aiModified = new Set<string>()
const changed = new Set<string>()

/**
 * Mark a file as having been modified by an AI tool (edit/write).
 * Call BEFORE publishing FileWatcher.Event.Updated so the subscriber
 * can distinguish AI-triggered changes from external modifications.
 */
export function markAiModified(file: string) {
  aiModified.add(AppFileSystem.resolve(file))
}

/**
 * Subscribe to raw FileWatcher events. Returns an unsubscribe Effect.
 * Every file change (AI or external) is recorded; filtering against
 * `aiModified` happens at `drain()` time.
 */
export function subscribe(bus: Bus.Interface) {
  return bus.subscribeCallback(FileWatcher.Event.Updated, (event) => {
    changed.add(AppFileSystem.resolve(event.properties.file))
  })
}

/**
 * Return files that changed externally since the last drain.
 * Any file in the watcher that was NOT also marked by an AI tool
 * is presumed to be an external modification.
 */
export function drain(): string[] {
  const result: string[] = []
  for (const file of changed) {
    if (!aiModified.has(file)) {
      result.push(file)
    }
  }
  changed.clear()
  aiModified.clear()
  return result
}

export * as ExternalChange from "./external-change"
