import { ConnectApi } from "../src/api"
import { ConnectHttp } from "../src/http"
import { generateDeviceKey } from "../src/proof"
import { FakeConnect } from "./fake-connect"

/** A started fake service plus a client wired to it; `deviceId` is set after register(). */
export async function harness() {
  const service = new FakeConnect().start()
  const { key } = await generateDeviceKey()
  const state = { deviceId: undefined as string | undefined }
  const http = new ConnectHttp({
    account: () => service.account(),
    key,
    deviceId: () => state.deviceId,
    client: { version: "1.2.3", platform: "linux" },
  })
  const api = new ConnectApi(http)
  return {
    service,
    http,
    api,
    key,
    state,
    async register() {
      state.deviceId = (await api.register("dev-box")).deviceId
      return state.deviceId
    },
    [Symbol.dispose]: () => service.stop(),
  }
}
