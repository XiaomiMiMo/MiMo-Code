type PromptStatus = "idle" | string

export function createPromptSubmitGuard() {
  let locked = false
  let observedRun = false

  return {
    tryStart(status: PromptStatus) {
      if (locked || status !== "idle") return false
      locked = true
      observedRun = false
      return true
    },
    update(status: PromptStatus) {
      if (!locked) return
      if (status !== "idle") {
        observedRun = true
        return
      }
      if (!observedRun) return
      locked = false
      observedRun = false
    },
    fail() {
      locked = false
      observedRun = false
    },
    releaseIfUnstarted(status: PromptStatus) {
      if (!locked || observedRun || status !== "idle") return
      locked = false
    },
  }
}
