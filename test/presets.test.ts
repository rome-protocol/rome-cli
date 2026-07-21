import { describe, it, expect } from "vitest";
import { getPreset } from "../src/core/presets.js";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";

// `preset <foundry|hardhat> <chain>` — a read that emits a ready Rome network config
// (RPC + chainId) plus the Rome quirks a builder needs (forge --skip-simulation, the
// estimateGas caveat). Sourced from the registry; on CLI + MCP.

describe("getPreset — Rome toolchain config", () => {
  it("foundry: emits an rpc_endpoints entry with the real RPC + the skip-simulation quirk", () => {
    const p = getPreset("foundry", "hadrian");
    expect(p.tool).toBe("foundry");
    expect(p.chainId).toBe(200010);
    expect(p.filename).toBe("foundry.toml");
    expect(p.config).toContain("https://hadrian.testnet.romeprotocol.xyz/");
    expect(p.config).toContain("rpc_endpoints");
    expect(p.notes.join(" ")).toMatch(/skip-simulation/i);
  });

  it("hardhat: emits a networks entry with url + chainId", () => {
    const p = getPreset("hardhat", "hadrian");
    expect(p.tool).toBe("hardhat");
    expect(p.filename).toMatch(/hardhat\.config/);
    expect(p.config).toContain("chainId: 200010");
    expect(p.config).toContain("https://hadrian.testnet.romeprotocol.xyz/");
  });

  it("resolves the chain by id/name/slug and errors on an unknown tool", () => {
    expect(getPreset("foundry", 200010).chainId).toBe(200010);
    expect(() => getPreset("truffle", "hadrian")).toThrow(/foundry|hardhat/i);
  });
});

describe("preset is a read capability on MCP", () => {
  it("registered as a read verb + present on the MCP surface", () => {
    const cap = CAPABILITIES.find((c) => c.id === "preset.preset");
    expect(cap?.kind).toBe("read");
    expect(cap?.requiresKey).toBe(false);
    expect(new Set(buildMcpTools().map((t) => t.name)).has("preset")).toBe(true);
  });
});
