interface Disposer {
  fn: (directory: string) => Promise<void>
  phase: "normal" | "late"
}

const disposers = new Set<Disposer>()

export function registerDisposer(
  fn: (directory: string) => Promise<void>,
  opts?: { phase?: "normal" | "late" },
) {
  const entry: Disposer = { fn, phase: opts?.phase ?? "normal" }
  disposers.add(entry)
  return () => {
    disposers.delete(entry)
  }
}

export async function disposeInstance(directory: string) {
  const normal: Disposer[] = []
  const late: Disposer[] = []
  for (const d of disposers) {
    if (d.phase === "late") late.push(d)
    else normal.push(d)
  }
  await Promise.allSettled(normal.map((d) => d.fn(directory)))
  await Promise.allSettled(late.map((d) => d.fn(directory)))
}
