/**
 * After a successful models.dev publish, rebuild provider state the same way
 * `/connect` does: dispose idle instances so TUI `server.instance.disposed`
 * bootstraps a fresh list. Active instances are skipped by `disposeAll`.
 */
export function watchModelsCatalogReload(options: {
  subscribe: (listener: () => void) => () => void
  reload: () => Promise<unknown>
  delayMs?: number
}): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = options.subscribe(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void options.reload().catch(() => {})
    }, options.delayMs ?? 300)
  })
  return () => {
    stop()
    if (timer) clearTimeout(timer)
    timer = undefined
  }
}
