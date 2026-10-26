import { PreviewBuilder, PreviewLimits, boundPreview } from "../packages/cli/src/snapshot/preview"

const before = process.memoryUsage()
let peak = before.rss
const start = performance.now()
const preview = new PreviewBuilder()
for (let i = 0; i < 100_000; i++) {
  const item = preview.add({
    file: `packages/example/file-${String(i).padStart(6, "0")}.ts`,
    patch: "",
    additions: 2,
    deletions: 1,
  })
  if (item) preview.patch(item, "before\n", "after\n")
  if (i % 1000 === 0) peak = Math.max(peak, process.memoryUsage().rss)
}
const value = boundPreview(preview.value.diffs, preview.value.summary)
const payloadBytes = Buffer.byteLength(JSON.stringify(value))
const after = process.memoryUsage()
peak = Math.max(peak, after.rss)
if (value.diffs.length > PreviewLimits.files || payloadBytes > PreviewLimits.payload || value.summary.files !== 100_000)
  throw new Error("Preview exceeded budget")
console.log(
  JSON.stringify({
    scenario: "100000 synthetic changed-file records; real preview builder and patch generation",
    elapsedMs: performance.now() - start,
    files: value.summary.files,
    retainedFiles: value.diffs.length,
    omittedFiles: value.summary.omittedFiles,
    payloadBytes,
    rssBefore: before.rss,
    rssAfter: after.rss,
    peakRss: peak,
    heapBefore: before.heapUsed,
    heapAfter: after.heapUsed,
  }),
)
