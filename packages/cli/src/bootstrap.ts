import { InstallationVersion } from "./installation/version"
import { isVersionRequest } from "./cli/version"

if (isVersionRequest(process.argv.slice(2))) {
  process.stdout.write(InstallationVersion + "\n")
} else {
  await import("./index")
}
