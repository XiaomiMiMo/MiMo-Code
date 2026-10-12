import "./node-bun-shim"
import { PluginHost } from "../../../src/plugin/host"

PluginHost.provideSdk()
console.log(JSON.stringify({ onlyConfigDir: PluginHost.onlyConfigDir() }))
