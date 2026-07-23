import { describe, it, expect } from "vitest";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";
import { parseFn, coerceArgs, sendContract } from "../src/core/actions.js";
import { requireEvmKey } from "../src/core/keys.js";

// Phase 2 introduces ACTIONS (deploy/send/…): CLI-only, key-gated, NEVER on the MCP surface.
// Read-only capabilities stay on both surfaces. This is the load-bearing security boundary.

describe("capability kinds", () => {
  it("every capability declares a kind of 'read' or 'action'", () => {
    for (const c of CAPABILITIES) {
      expect(c.kind === "read" || c.kind === "action").toBe(true);
    }
  });

  it("facts + cookbook stay read-only", () => {
    for (const c of CAPABILITIES.filter((c) => c.group === "facts" || c.group === "cookbook")) {
      expect(c.kind).toBe("read");
    }
  });

  it("there is at least one action; every action requires a key EXCEPT the explicit keyless set", () => {
    const actions = CAPABILITIES.filter((c) => c.kind === "action");
    expect(actions.length).toBeGreaterThan(0);
    // `new` scaffolds to disk but signs nothing — the ONLY keyless action. Anything
    // else keyless is a bug: signing actions must fail fast on a missing env key.
    const KEYLESS = new Set(["new.new"]);
    for (const a of actions) expect(a.requiresKey, a.id).toBe(!KEYLESS.has(a.id));
  });
});

describe("MCP surface excludes actions (no keys ever reach MCP)", () => {
  it("the MCP tool list contains ONLY read capabilities", () => {
    const toolCaps = buildMcpTools().map((t) => t.capability);
    expect(toolCaps.every((c) => c.kind === "read")).toBe(true);
  });

  it("no action capability is exposed as an MCP tool", () => {
    const toolNames = new Set(buildMcpTools().map((t) => t.name));
    for (const a of CAPABILITIES.filter((c) => c.kind === "action")) {
      expect(toolNames.has(a.mcpTool)).toBe(false);
    }
  });

  it("MCP tool count === read-capability count", () => {
    const reads = CAPABILITIES.filter((c) => c.kind === "read").length;
    expect(buildMcpTools().length).toBe(reads);
  });
});

describe("Phase 2 commands are present as actions", () => {
  it("deploy / send / call exist", () => {
    const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));
    expect(byId.get("contract.deploy")?.kind).toBe("action");
    expect(byId.get("contract.send")?.kind).toBe("action");
    // `call` is a read (eth_call) — CLI + MCP:
    expect(byId.get("contract.call")?.kind).toBe("read");
  });
});

describe("action helpers", () => {
  it("parseFn accepts bare + full signatures", () => {
    expect(parseFn("balanceOf(address)").name).toBe("balanceOf");
    expect(parseFn("function deposit(uint256) returns (bool)").name).toBe("deposit");
    expect(() => parseFn("not a sig!!")).toThrow();
  });
  it("coerceArgs types uint→bigint, bool→boolean, address→string", () => {
    const out = coerceArgs([{ type: "uint256" }, { type: "bool" }, { type: "address" }], "42, true, 0xabc");
    expect(out).toEqual([42n, true, "0xabc"]);
    expect(coerceArgs([], undefined)).toEqual([]);
  });
});

describe("action key-gating (no key → clear error, nothing leaks)", () => {
  it("requireEvmKey throws a clear error when unset", () => {
    const prev = process.env.ROME_EVM_KEY;
    delete process.env.ROME_EVM_KEY;
    try {
      expect(() => requireEvmKey()).toThrow(/ROME_EVM_KEY/);
    } finally {
      if (prev !== undefined) process.env.ROME_EVM_KEY = prev;
    }
  });
  it("an action (send) refuses without a key rather than doing anything", async () => {
    const prev = process.env.ROME_EVM_KEY;
    delete process.env.ROME_EVM_KEY;
    try {
      await expect(sendContract("hadrian", "0x0000000000000000000000000000000000000001", "deposit(uint256)", "1")).rejects.toThrow(
        /ROME_EVM_KEY/,
      );
    } finally {
      if (prev !== undefined) process.env.ROME_EVM_KEY = prev;
    }
  });
});
