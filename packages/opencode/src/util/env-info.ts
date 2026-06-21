import os from "os"
import { Global } from "@/global"
import { InstallationChannel, InstallationVersion } from "@/installation/version"
import { getInstallationID } from "@/metrics/installation"
import { MIMOCODE_PROCESS_ROLE, MIMOCODE_RUN_ID } from "./mimo-process"

function username() {
  if (process.env.USER) return process.env.USER
  if (process.env.USERNAME) return process.env.USERNAME
  return os.userInfo().username
}

function locale() {
  return Intl.DateTimeFormat().resolvedOptions().locale
}

function timezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}


export function getEnvInfo() {
  const cpus = os.cpus()

  return {
    os: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
    },
    cpu: {
      model: cpus[0]?.model ?? "unknown",
      count: cpus.length,
    },
    memory: {
      total_bytes: os.totalmem(),
    },
    runtime: {
      bun_version: Bun.version,
      node_version: process.versions.node,
      timezone: timezone(),
      locale: locale(),
    },
    mimocode: {
      version: InstallationVersion,
      channel: InstallationChannel,
    },
  }
}