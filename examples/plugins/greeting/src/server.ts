import type { PluginModule } from "@mimo-ai/plugin"
import { tool } from "@mimo-ai/plugin/tool"

export default {
  id: "example.greeting",
  async server() {
    return {
      tool: {
        greet: tool({
          description: "Return a greeting for a name",
          args: {
            name: tool.schema.string().describe("Name to greet"),
          },
          async execute(args) {
            return `Hello, ${args.name}!`
          },
        }),
      },
    }
  },
} satisfies PluginModule
