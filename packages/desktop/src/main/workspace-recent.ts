import { getStore } from "./store"

const RECENT_KEY = "recentProjects"
const MAX_RECENT = 5

export function getRecentProjects(): string[] {
  const raw = getStore().get(RECENT_KEY)
  if (!Array.isArray(raw)) return []
  return raw.slice(0, MAX_RECENT).filter((p): p is string => typeof p === "string")
}

export function setRecentProjects(directories: string[]) {
  const next = directories.slice(0, MAX_RECENT)
  getStore().set(RECENT_KEY, next)
}

export function addRecentProject(directory: string) {
  const current = getRecentProjects()
  const next = [directory, ...current.filter((d) => d !== directory)].slice(0, MAX_RECENT)
  getStore().set(RECENT_KEY, next)
}

export function clearRecentProjects() {
  getStore().delete(RECENT_KEY)
}
