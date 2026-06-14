import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.DEVORA_CHANNEL ?? "dev"}`

await $`cd ../devora && bun script/build-node.ts`
