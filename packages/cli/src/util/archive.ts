import path from "path"
import * as Process from "./process"
import { WindowsPowerShell } from "./windows-powershell"

export async function extractZip(zipPath: string, destDir: string) {
  if (process.platform === "win32") {
    const winZipPath = path.resolve(zipPath)
    const winDestDir = path.resolve(destDir)
    // $global:ProgressPreference suppresses PowerShell's blue progress bar popup
    const cmd = `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -Path '${winZipPath}' -DestinationPath '${winDestDir}' -Force`
    await Process.run([WindowsPowerShell.executable(), "-NoProfile", "-NonInteractive", "-Command", cmd], {
      env: WindowsPowerShell.env(),
    })
    return
  }

  await Process.run(["unzip", "-o", "-q", zipPath, "-d", destDir])
}
