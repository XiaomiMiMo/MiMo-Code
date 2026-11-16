#!/usr/bin/env bun
// Duration-weighted test sharding for CI.
//
//   bun script/test-shard.ts <index> <total> [--reserve s1,s2,...] < files.txt
//     Prints the test files (one per line, relative to packages/cli) assigned
//     to 1-based shard <index> of <total>. --reserve gives seconds each shard
//     already spends outside the shared run (isolated suites), so the split
//     balances the whole job rather than only the shared run.
//
//   bun script/test-shard.ts --update <junit.xml>...
//     Rewrites test/shard-weights.json from JUnit reports.
import path from "node:path"

const WEIGHTS = path.join(import.meta.dir, "../test/shard-weights.json")
const DEFAULT_WEIGHT = 1

export function assign(files: string[], total: number, weights: Record<string, number>, reserve: number[] = []) {
  const shards = Array.from({ length: total }, (_, i) => ({ load: reserve[i] ?? 0, files: [] as string[] }))
  const weight = (file: string) => weights[file] ?? DEFAULT_WEIGHT
  const sorted = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))
  for (const file of sorted) {
    const target = shards.reduce((min, shard) => (shard.load < min.load ? shard : min))
    target.load += weight(file)
    target.files.push(file)
  }
  return shards.map((shard) => ({ load: shard.load, files: shard.files.sort() }))
}

export function weightsFromJUnit(reports: string[]) {
  const totals = new Map<string, number[]>()
  for (const xml of reports) {
    const perFile = new Map<string, number>()
    for (const match of xml.matchAll(/<testcase\b[^>]*>/g)) {
      const file = /\bfile="([^"]+)"/.exec(match[0])?.[1]
      const time = Number(/\btime="([^"]+)"/.exec(match[0])?.[1] ?? 0)
      if (!file) continue
      perFile.set(file, (perFile.get(file) ?? 0) + (Number.isFinite(time) ? time : 0))
    }
    for (const [file, time] of perFile) totals.set(file, [...(totals.get(file) ?? []), time])
  }
  return Object.fromEntries(
    [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([file, times]) => [file, Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10]),
  )
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === "--update") {
    if (args.length < 2) throw new Error("usage: test-shard.ts --update <junit.xml>...")
    const reports = await Promise.all(args.slice(1).map((file) => Bun.file(file).text()))
    await Bun.write(WEIGHTS, JSON.stringify(weightsFromJUnit(reports), null, 2) + "\n")
  } else {
    const index = Number(args[0])
    const total = Number(args[1])
    const usage = "usage: test-shard.ts <index> <total> [--reserve s1,s2,...] < files.txt"
    if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) throw new Error(usage)
    const reserve =
      args[2] === "--reserve" ? (args[3] ?? "").split(",").map(Number) : args.length > 2 ? [Number.NaN] : []
    if (reserve.length > total || reserve.some((s) => !Number.isFinite(s) || s < 0)) throw new Error(usage)
    const files = (await Bun.stdin.text())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    const weights: Record<string, number> = await Bun.file(WEIGHTS).json()
    const shard = assign(files, total, weights, reserve)[index - 1]!
    if (shard.files.length > 0) process.stdout.write(shard.files.join("\n") + "\n")
  }
}
