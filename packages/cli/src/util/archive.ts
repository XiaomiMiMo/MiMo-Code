import path from "path"
import * as Process from "./process"
import { WindowsPowerShell } from "./windows-powershell"

export async function extractZip(zipPath: string, destDir: string) {
  if (process.platform === "win32") {
    // Paths travel through env vars and -LiteralPath so quotes and [ ] in them stay literal.
    // $global:ProgressPreference suppresses PowerShell's blue progress bar popup
    const cmd =
      "$global:ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Expand-Archive -LiteralPath $env:MIMO_ZIP_PATH -DestinationPath $env:MIMO_ZIP_DEST -Force"
    await Process.run([WindowsPowerShell.executable(), "-NoProfile", "-NonInteractive", "-Command", cmd], {
      env: WindowsPowerShell.env({ MIMO_ZIP_PATH: path.resolve(zipPath), MIMO_ZIP_DEST: path.resolve(destDir) }),
    })
    return
  }

  await Process.run(["unzip", "-o", "-q", zipPath, "-d", destDir])
}
