import { Bus } from "@/bus"
import { Config } from "@/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@/flag/flag"
import { Installation } from "@/installation"
import { InstallationLocal, InstallationVersion } from "@/installation/version"
import { Log } from "@/util"

const log = Log.create({ service: "upgrade" })

export async function upgrade() {
  if (InstallationLocal) return
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  const method = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.method()))
  const latest = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.latest(method))).catch((err) => {
    log.warn("failed to check for updates", { method, error: String(err) })
  })
  if (!latest) return

  if (Flag.MIMOCODE_ALWAYS_NOTIFY_UPDATE) {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (InstallationVersion === latest) return
  if (config.autoupdate === false || Flag.MIMOCODE_DISABLE_AUTOUPDATE) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (method === "unknown") return
  await AppRuntime.runPromise(Installation.Service.use((svc) => svc.upgrade(method, latest)))
    .then(() => Bus.publish(Installation.Event.Updated, { version: latest }))
    .catch((err) => {
      log.warn("auto-upgrade failed", { method, target: latest, error: String(err) })
    })
}
