// History (trajectory search) module entry.
//
// `History.defaultLayer` provides three services: History (search/around),
// HistoryWriter (Bus subscriber), and HistoryBackfill (startup scan).
// HistoryWriter and HistoryBackfill must be activated by calling `init()` at
// bootstrap time — see `packages/opencode/src/project/bootstrap.ts`. Layer-merge
// alone does NOT start them (mirrors the ShareNext / Vcs / FileWatcher pattern).
export * as History from "./service"
export { Service as WriterService } from "./writer"
export { Service as BackfillService } from "./backfill"
