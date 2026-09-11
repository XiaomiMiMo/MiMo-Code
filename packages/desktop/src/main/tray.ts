import { Menu, Tray, app, nativeImage } from "electron"
import { join } from "node:path"
import { existsSync } from "node:fs"

let tray: Tray | null = null
let currentDeps: TrayDeps | null = null

export type TrayDeps = {
  onShowWindow: () => void
  onQuit: () => void
}

function trayIconPath() {
  const candidates = [
    join(app.getAppPath(), "resources/icons/tray.png"),
    join(app.getAppPath(), "resources/icons/trayTemplate.png"),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return candidates[0]
}

export function createTray(deps: TrayDeps): Tray | null {
  if (process.platform !== "darwin") return null
  if (tray) return tray

  currentDeps = deps

  const iconPath = trayIconPath()
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    image = nativeImage.createEmpty()
  } else {
    image.setTemplateImage(true)
  }

  tray = new Tray(image)
  tray.setTitle("")
  tray.setToolTip("MiMo-Code")

  rebuildMenu(deps)
  return tray
}

export function rebuildMenu(deps: TrayDeps) {
  if (!tray) return
  currentDeps = deps

  const menu = Menu.buildFromTemplate([
    {
      label: "Open MiMoCode",
      click: () => deps.onShowWindow(),
    },
    { type: "separator" },
    {
      label: "Quit",
      accelerator: "Cmd+Q",
      click: () => deps.onQuit(),
    },
  ])
  tray.setContextMenu(menu)
}

export function destroyTray() {
  if (!tray) return
  tray.destroy()
  tray = null
  currentDeps = null
}
