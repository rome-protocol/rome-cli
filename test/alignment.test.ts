import { describe, it, expect } from "vitest";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";
import { cliCommandTable } from "../src/cli.js";

// The load-bearing invariant: the CLI and the MCP surface are the SAME capabilities,
// because both derive from CAPABILITIES. This test fails the moment they drift.

describe("capability registry integrity", () => {
  it("every capability has a unique id / group+command / mcp tool", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    const tools = CAPABILITIES.map((c) => c.mcpTool);
    const pairs = CAPABILITIES.map((c) => `${c.group} ${c.command}`);
    expect(new Set(ids).size).toBe(CAPABILITIES.length);
    expect(new Set(tools).size).toBe(CAPABILITIES.length);
    expect(new Set(pairs).size).toBe(CAPABILITIES.length);
  });
  it("mcp tool + cliPath are deterministically derived (grouped vs verb), underscore-normalized", () => {
    for (const c of CAPABILITIES) {
      const expectedTool = (c.verb ? c.command : `${c.group}_${c.command}`).replace(/-/g, "_");
      const expectedCli = c.verb ? c.command : `${c.group} ${c.command}`;
      expect(c.mcpTool).toBe(expectedTool);
      expect(c.cliPath).toBe(expectedCli);
      expect(c.mcpTool).toMatch(/^[a-z0-9_]+$/);
      expect(typeof c.handler).toBe("function");
    }
  });
});

describe("both surfaces expose exactly the capability set", () => {
  it("CLI command table === every capability's cliPath", () => {
    const cli = cliCommandTable().sort();
    const caps = CAPABILITIES.map((c) => c.cliPath).sort();
    expect(cli).toEqual(caps);
  });
  it("MCP tool list === the READ-ONLY capabilities (actions excluded)", () => {
    const tools = buildMcpTools()
      .map((t) => t.name)
      .sort();
    const readCaps = CAPABILITIES.filter((c) => c.kind === "read")
      .map((c) => c.mcpTool)
      .sort();
    expect(tools).toEqual(readCaps);
  });
});
