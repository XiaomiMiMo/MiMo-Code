export type CronFields = {
  minute: number[]
  hour: number[]
  dom: number[]
  month: number[]
  dow: number[]
}

const FIELD_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
]

function expandField(token: string, [lo, hi]: [number, number]): number[] | null {
  const out = new Set<number>()
  for (const part of token.split(",")) {
    const [range, stepStr] = part.split("/")
    const step = stepStr ? parseInt(stepStr, 10) : 1
    if (!Number.isFinite(step) || step < 1) return null
    const [startStr, endStr] = range === "*" ? [String(lo), String(hi)] : range.split("-")
    const start = parseInt(startStr, 10)
    const end = endStr === undefined ? (stepStr ? hi : start) : parseInt(endStr, 10)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    if (start < lo || end > hi || start > end) return null
    for (let n = start; n <= end; n += step) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const fields = parts.map((p, i) => expandField(p, FIELD_RANGES[i]))
  if (fields.some((f) => f === null)) return null
  return {
    minute: fields[0]!,
    hour: fields[1]!,
    dom: fields[2]!,
    month: fields[3]!,
    dow: fields[4]!,
  }
}

export function computeNextCronRun(expr: string, from: Date): Date | null {
  const f = parseCronExpression(expr)
  if (!f) return null
  const limit = new Date(from.getTime() + 365 * 24 * 60 * 60 * 1000)
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  while (d <= limit) {
    if (
      f.month.includes(d.getMonth() + 1) &&
      f.dom.includes(d.getDate()) &&
      f.dow.includes(d.getDay()) &&
      f.hour.includes(d.getHours()) &&
      f.minute.includes(d.getMinutes())
    )
      return d
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}

export function cronToHuman(expr: string): string {
  const m = expr.match(/^\*\/(\d+) \* \* \* \*$/)
  if (m) return `every ${m[1]} minutes`
  if (expr === "0 * * * *") return "hourly"
  const dayMap: Record<string, string> = { "1-5": "weekdays", "0,6": "weekends" }
  const wd = expr.match(/^(\d+) (\d+) \* \* (.+)$/)
  if (wd && dayMap[wd[3]]) return `${dayMap[wd[3]]} at ${wd[2]}:${wd[1].padStart(2, "0")}`
  const pinned = expr.match(/^(\d+) (\d+) (\d+) (\d+) \*$/)
  if (pinned) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return `${months[+pinned[4] - 1]} ${pinned[3]} ${pinned[2]}:${pinned[1].padStart(2, "0")}`
  }
  return expr
}
