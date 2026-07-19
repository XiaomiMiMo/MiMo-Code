#!/usr/bin/env bun
import { Script } from "@mimo-ai/script"

const PACKAGES = [
  "@mimo-ai/cli",
  "@mimo-ai/mimocode-darwin-arm64",
  "@mimo-ai/mimocode-darwin-x64",
  "@mimo-ai/mimocode-darwin-x64-baseline",
  "@mimo-ai/mimocode-linux-arm64",
  "@mimo-ai/mimocode-linux-arm64-musl",
  "@mimo-ai/mimocode-linux-x64",
  "@mimo-ai/mimocode-linux-x64-baseline",
  "@mimo-ai/mimocode-linux-x64-musl",
  "@mimo-ai/mimocode-linux-x64-baseline-musl",
  "@mimo-ai/mimocode-windows-arm64",
  "@mimo-ai/mimocode-windows-x64",
  "@mimo-ai/mimocode-windows-x64-baseline",
]

const REGISTRIES = {
  npmmirror: {
    name: "npmmirror (淘宝)",
    registry: "https://registry.npmmirror.com",
    syncUrl: "https://registry-direct.npmmirror.com",
    type: "sync-api" as const,
  },
  tencent: {
    name: "腾讯云",
    registry: "https://mirrors.cloud.tencent.com/npm",
    type: "proxy" as const,
  },
  huawei: {
    name: "华为云",
    registry: "https://mirrors.huaweicloud.com/repository/npm",
    type: "proxy" as const,
  },
}

type RegistryKey = keyof typeof REGISTRIES

const CONCURRENCY = 5
const POLL_INTERVAL = 3000
const POLL_TIMEOUT = 120000

async function syncNpmmirror(packageName: string) {
  const encoded = encodeURIComponent(packageName)
  const url = `${REGISTRIES.npmmirror.syncUrl}/-/package/${encoded}/syncs`
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skipDependencies: true, tips: "MiMoCode release sync" }),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`  ✗ ${packageName}: ${res.status} ${text}`)
    return null
  }
  const data = (await res.json()) as { ok: boolean; id?: string; logId?: string }
  return data.id || data.logId || null
}

async function pollSyncStatus(packageName: string, taskId: string) {
  const encoded = encodeURIComponent(packageName)
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT) {
    await Bun.sleep(POLL_INTERVAL)
    const res = await fetch(
      `${REGISTRIES.npmmirror.syncUrl}/-/package/${encoded}/syncs/${taskId}`,
    )
    if (!res.ok) continue
    const data = (await res.json()) as { state?: string }
    if (data.state === "success") return "success"
    if (data.state === "error") return "error"
  }
  return "timeout"
}

async function warmProxy(packageName: string, registry: { name: string; registry: string }) {
  const encoded = encodeURIComponent(packageName)
  const url = `${registry.registry}/${encoded}`
  const res = await fetch(url, { method: "GET" })
  if (res.ok) {
    console.log(`  ✓ ${packageName} → ${registry.name}`)
  } else {
    console.error(`  ✗ ${packageName} → ${registry.name}: ${res.status}`)
  }
  await res.text()
}

async function runConcurrent<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  const queue = [...items]
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!
      await fn(item)
    }
  })
  await Promise.all(workers)
}

async function syncToNpmmirror() {
  console.log(`\n▶ Syncing to npmmirror (${REGISTRIES.npmmirror.syncUrl})`)
  console.log(`  Triggering sync for ${PACKAGES.length} packages...\n`)

  const tasks: { pkg: string; taskId: string }[] = []
  await runConcurrent(PACKAGES, CONCURRENCY, async (name) => {
    const taskId = await syncNpmmirror(name)
    if (taskId) {
      console.log(`  ↻ ${name} → queued (${taskId})`)
      tasks.push({ pkg: name, taskId })
    }
  })

  if (tasks.length === 0) {
    console.log("  No sync tasks created.")
    return
  }

  console.log(`\n  Polling ${tasks.length} sync tasks...`)
  await runConcurrent(tasks, CONCURRENCY, async (task) => {
    const result = await pollSyncStatus(task.pkg, task.taskId)
    const icon = result === "success" ? "✓" : result === "error" ? "✗" : "⏱"
    console.log(`  ${icon} ${task.pkg}: ${result}`)
  })
}

async function syncToProxy(key: RegistryKey) {
  const registry = REGISTRIES[key]
  if (registry.type !== "proxy") return
  console.log(`\n▶ Warming cache on ${registry.name} (${registry.registry})`)
  await runConcurrent(PACKAGES, CONCURRENCY, (name) => warmProxy(name, registry))
}

const target = process.argv[2] as RegistryKey | "all" | undefined

if (target && target !== "all" && !(target in REGISTRIES)) {
  console.error(`Unknown registry: ${target}`)
  console.error(`Usage: sync-registry.ts [npmmirror|tencent|huawei|all]`)
  process.exit(1)
}

console.log("═══ MiMoCode Registry Sync ═══")
console.log(`Version: ${Script.version} (${Script.channel})`)
console.log(`Packages: ${PACKAGES.length}`)

if (!target || target === "all" || target === "npmmirror") {
  await syncToNpmmirror()
}
if (!target || target === "all" || target === "tencent") {
  await syncToProxy("tencent")
}
if (!target || target === "all" || target === "huawei") {
  await syncToProxy("huawei")
}

console.log("\n═══ Done ═══")
