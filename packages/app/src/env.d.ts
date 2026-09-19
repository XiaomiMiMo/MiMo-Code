interface ImportMetaEnv {
  readonly VITE_MIMOCODE_SERVER_HOST: string
  readonly VITE_MIMOCODE_SERVER_PORT: string
  readonly VITE_MIMOCODE_CHANNEL?: "dev" | "beta" | "prod"
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
