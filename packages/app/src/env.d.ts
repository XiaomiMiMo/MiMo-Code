interface ImportMetaEnv {
  readonly VITE_DEVORA_SERVER_HOST: string
  readonly VITE_DEVORA_SERVER_PORT: string
  readonly VITE_DEVORA_CHANNEL?: "dev" | "beta" | "prod"
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
