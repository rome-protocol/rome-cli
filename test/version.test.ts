import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PKG_VERSION } from "../src/core/version.js";

// One version, sourced from package.json — the CLI banner and the MCP serverInfo
// must never drift from the released package version again.

describe("PKG_VERSION", () => {
  it("matches package.json version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(PKG_VERSION).toBe(pkg.version);
  });

  it("is consumed by the MCP server module (no hardcoded serverInfo version)", () => {
    const mcpSrc = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
    expect(mcpSrc).toContain("PKG_VERSION");
    expect(mcpSrc).not.toMatch(/version:\s*"0\.1\.0"/);
  });
});
