import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import { CAPABILITIES, type Capability } from "./core/capabilities.js";
import { defaultDeps } from "./core/deps.js";

export interface McpToolDef {
  name: string;
  description: string;
  capability: Capability;
}

/**
 * The MCP tool list — ONLY read-only capabilities. Actions (deploy/send/…) need a signing
 * key and are CLI-only; they are never exposed as MCP tools, so a key can never reach MCP.
 */
export function buildMcpTools(): McpToolDef[] {
  return CAPABILITIES.filter((c) => c.kind === "read").map((c) => ({ name: c.mcpTool, description: c.summary, capability: c }));
}

function inputShape(cap: Capability): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const arg of cap.args) {
    const base = z.string().describe(arg.description);
    shape[arg.name] = arg.required ? base : base.optional();
  }
  return shape;
}

/** Start the read-only MCP server over stdio. Holds no keys; every tool is a read. */
export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: "rome-mcp", version: "0.1.0" });
  for (const { name, description, capability } of buildMcpTools()) {
    server.registerTool(name, { description, inputSchema: inputShape(capability) }, async (args: Record<string, unknown>) => {
      const strArgs: Record<string, string> = {};
      for (const [k, v] of Object.entries(args ?? {})) if (v != null) strArgs[k] = String(v);
      try {
        const result = await capability.handler(strArgs, defaultDeps);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    });
  }
  await server.connect(new StdioServerTransport());
}
