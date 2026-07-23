import { describe, it, expect, vi } from "vitest";
import { runNew, projectChainEnv, type NewDeps } from "../src/core/new.js";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";

// `rome new <app-name> [--chain <chain>]` — scaffold a dual-lane app by WRAPPING
// create-rome-app (the scaffolder stays canonical), then pre-wire the chosen chain
// into .env and hand back grounded next steps (fund → deploy → demo → verify).
// CLI-only (MCP never writes to disk) but KEYLESS — signs nothing.

function deps(over: Partial<NewDeps> = {}, order: string[] = []): NewDeps {
  return {
    targetExists: vi.fn(() => false),
    scaffold: vi.fn(async () => void order.push("scaffold")),
    writeChainEnv: vi.fn(async () => void order.push("env")),
    ...over,
  };
}

describe("runNew — scaffold, pre-wire chain, grounded next steps", () => {
  it("resolves the chain, scaffolds, writes the env, and returns lifecycle next-steps", async () => {
    const order: string[] = [];
    const d = deps({}, order);
    const r = await runNew("my-app", "hadrian", d);
    expect(order).toEqual(["scaffold", "env"]);
    expect(d.writeChainEnv).toHaveBeenCalledWith("my-app", 200010);
    expect(r.app).toBe("my-app");
    expect(r.chainId).toBe(200010);
    const next = r.next.join("\n");
    expect(next).toMatch(/rome fund/);
    expect(next).toMatch(/npm run deploy/);
    expect(next).toMatch(/npm run demo/);
    expect(next).toMatch(/rome verify/);
  });

  it("fails fast on an unknown chain BEFORE scaffolding (no npx spend)", async () => {
    const d = deps();
    await expect(runNew("my-app", "not-a-chain", d)).rejects.toThrow(/[Uu]nknown chain/);
    expect(d.scaffold).not.toHaveBeenCalled();
  });

  it("rejects a bad app name (empty / path-y) before scaffolding", async () => {
    const d = deps();
    await expect(runNew("", "hadrian", d)).rejects.toThrow(/app name/i);
    await expect(runNew("../evil", "hadrian", d)).rejects.toThrow(/app name/i);
    expect(d.scaffold).not.toHaveBeenCalled();
  });

  it("refuses to scaffold over an existing directory", async () => {
    const d = deps({ targetExists: vi.fn(() => true) });
    await expect(runNew("taken", "hadrian", d)).rejects.toThrow(/exists/);
    expect(d.scaffold).not.toHaveBeenCalled();
  });
});

describe("projectChainEnv — .env.example → .env with the chain pre-wired", () => {
  it("uncomments/sets CHAIN_ID, preserving the rest of the file", () => {
    const example = "# Chain — defaults to Rome Hadrian.\n# CHAIN_ID=200010\nPROXY_URL=\nEVM_KEY=0xYOUR_EVM_PRIVATE_KEY\n";
    const out = projectChainEnv(example, 121214);
    expect(out).toContain("CHAIN_ID=121214");
    expect(out).not.toMatch(/^# CHAIN_ID=/m);
    expect(out).toContain("PROXY_URL=");
    expect(out).toContain("EVM_KEY=0xYOUR_EVM_PRIVATE_KEY");
  });

  it("appends CHAIN_ID when the example has no CHAIN_ID line at all", () => {
    const out = projectChainEnv("PROXY_URL=\n", 200010);
    expect(out).toMatch(/^CHAIN_ID=200010$/m);
    expect(out).toContain("PROXY_URL=");
  });
});

describe("new is CLI-only but KEYLESS", () => {
  it("registered as a keyless verb action, absent from the MCP surface", () => {
    const cap = CAPABILITIES.find((c) => c.id === "new.new");
    expect(cap?.kind).toBe("action");
    expect(cap?.requiresKey).toBe(false); // scaffolding signs nothing
    expect(cap?.verb).toBe(true);
    expect(new Set(buildMcpTools().map((t) => t.name)).has("new")).toBe(false);
  });

  it("the handler runs with NO ROME_EVM_KEY in the environment (fails only on its own args)", async () => {
    const prev = process.env.ROME_EVM_KEY;
    delete process.env.ROME_EVM_KEY;
    try {
      const cap = CAPABILITIES.find((c) => c.id === "new.new")!;
      // missing app name → its own arg error, NOT a key error
      await expect(Promise.resolve(cap.handler({ chain: "hadrian" }))).rejects.toThrow(/app name/i);
    } finally {
      if (prev !== undefined) process.env.ROME_EVM_KEY = prev;
    }
  });
});
