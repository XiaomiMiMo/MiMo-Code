// Scaffold build stub — MiMo Free tier is a Xiaomi-specific provider not bundled here.
// This file satisfies the import in plugin/index.ts and cli/cmd/providers.ts.
export const MimoFree = {
  chatBaseUrl: "",
  verify: async (): Promise<{ fingerprint: string; exp: number }> => {
    throw new Error("MiMo Free provider is not available in Scaffold")
  },
}

export const MimoFreeAuthPlugin = async () => ({})
