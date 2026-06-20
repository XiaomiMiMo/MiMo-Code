import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, Browser, Page } from "@playwright/test";

let browser: Browser | null = null;
let page: Page | null = null;
let consoleErrors: string[] = [];

async function getPage(): Promise<Page> {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  if (!page) {
    page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(err.message);
    });
  }
  return page;
}

const server = new Server(
  {
    name: "mimo-mcp-browser",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "browser_goto",
        description: "Navigates the browser to a URL",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
      },
      {
        name: "browser_click",
        description: "Clicks on an element matching the selector",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string" },
          },
          required: ["selector"],
        },
      },
      {
        name: "browser_capture_screenshot",
        description: "Takes a screenshot of the current page",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "browser_get_console_errors",
        description: "Returns JavaScript console errors",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const p = await getPage();

  switch (request.params.name) {
    case "browser_goto": {
      const url = String(request.params.arguments?.url);
      await p.goto(url);
      return {
        content: [{ type: "text", text: `Navigated to ${url}` }],
      };
    }
    case "browser_click": {
      const selector = String(request.params.arguments?.selector);
      await p.click(selector);
      return {
        content: [{ type: "text", text: `Clicked ${selector}` }],
      };
    }
    case "browser_capture_screenshot": {
      const screenshot = await p.screenshot({ type: "png" });
      return {
        content: [
          {
            type: "image",
            data: screenshot.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    }
    case "browser_get_console_errors": {
      const errors = [...consoleErrors];
      consoleErrors = [];
      return {
        content: [{ type: "text", text: JSON.stringify(errors) }],
      };
    }
    default:
      throw new Error("Unknown tool");
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Browser MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
