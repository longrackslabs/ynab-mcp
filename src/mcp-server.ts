// The MCP Server wiring, shared by every transport (stdio in index.ts, HTTP in
// server.ts). Given a ToolContext, registers the ListTools/CallTool handlers —
// toolset/read-only gating on list, Zod-aware error wrapping on call.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolContext } from "./tools.js";

import { handleTool, isToolEnabledForContext, TOOLS } from "./tools.js";

export function buildMcpServer(ctx: ToolContext): Server {
  const server = new Server({ name: "ynab", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.filter((t) => isToolEnabledForContext(ctx, t)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const text = await handleTool(ctx, request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? `Validation error: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
          : err instanceof Error
            ? err.message
            : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}
