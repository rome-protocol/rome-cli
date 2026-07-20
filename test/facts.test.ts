import { describe, it, expect } from "vitest";
import { resolveChainId, getChainFacts, getTokenFacts, getGasFacts, getBalanceFacts, getProgramFacts } from "../src/core/facts.js";
import type { Deps } from "../src/core/deps.js";

// Hadrian is a published chain in @rome-protocol/registry (Hadrian + Martius only, R13).
const HADRIAN = 200010;

// Deterministic RPC stub so facts tests never hit the network; live values ride the works-gate.
const stubDeps: Deps = {
  makeRpc: () => ({
    getGasPrice: async () => 1_000_000n,
    getBalance: async () => 5_000_000_000_000_000_000n,
  }),
};

describe("resolveChainId — flexible input", () => {
  it("accepts a numeric id", () => {
    expect(resolveChainId("200010")).toBe(HADRIAN);
    expect(resolveChainId(200010)).toBe(HADRIAN);
  });
  it("accepts a short name / slug", () => {
    expect(resolveChainId("hadrian")).toBe(HADRIAN);
    expect(resolveChainId("200010-hadrian")).toBe(HADRIAN);
  });
  it("accepts the full name the tool itself prints (regression: must NOT return the wrong chain)", () => {
    // Every chain is named "Rome <X>"; a shared token must not resolve to the first chain.
    expect(resolveChainId("Rome Hadrian")).toBe(HADRIAN);
    expect(resolveChainId("Rome Martius")).toBe(121214);
  });
  it("rejects an ambiguous shared prefix instead of guessing", () => {
    expect(() => resolveChainId("rome")).toThrow(/ambiguous|unknown/i);
  });
  it("rejects a numeric superstring instead of silently matching (regression)", () => {
    expect(() => resolveChainId("2000109")).toThrow(/unknown/i);
    expect(() => resolveChainId("1200010")).toThrow(/unknown/i);
  });
  it("throws a helpful error listing known chains for an unknown input", () => {
    expect(() => resolveChainId("nope-chain")).toThrow(/known chains/i);
  });
});

describe("getChainFacts", () => {
  it("returns real registry values for Hadrian", () => {
    const c = getChainFacts("hadrian");
    expect(c.chainId).toBe(HADRIAN);
    expect(c.name).toMatch(/hadrian/i);
    expect(c.rpcUrl).toMatch(/^https:\/\//);
    expect(c.romeEvmProgramId).toBeTruthy();
    expect(c.nativeCurrency.symbol).toBe("USDC");
  });
});

describe("getTokenFacts", () => {
  it("returns a token list and surfaces the match-by-mint note", () => {
    const r = getTokenFacts("200010") as { tokens: unknown[]; note: string };
    expect(Array.isArray(r.tokens)).toBe(true);
    expect(r.note).toMatch(/mint/i);
  });
});

describe("getProgramFacts", () => {
  it("returns real Solana program ids for devnet", () => {
    const r = getProgramFacts("devnet") as { network: string; programs: Record<string, string> };
    expect(r.network).toBe("devnet");
    expect(Object.keys(r.programs).length).toBeGreaterThan(0);
    expect(r.programs.splToken).toBeTruthy();
  });
  it("accepts testnet without dead-ending (empty is fine)", () => {
    const r = getProgramFacts("testnet") as { network: string; programs: Record<string, string> };
    expect(r.network).toBe("testnet");
    expect(typeof r.programs).toBe("object");
  });
  it("rejects an invalid network", () => {
    expect(() => getProgramFacts("banana")).toThrow(/network/i);
  });
});

describe("getGasFacts + getBalanceFacts (RPC via injected deps)", () => {
  it("gas returns a price and the estimate-vs-charge caveat", async () => {
    const r = (await getGasFacts("hadrian", stubDeps)) as { gasPriceWei: string; note: string };
    expect(r.gasPriceWei).toBe("1000000");
    expect(r.note).toMatch(/estimate|1\.48M|exact/i);
  });
  it("balance returns the raw wei for an address", async () => {
    const r = (await getBalanceFacts(
      "hadrian",
      "0x0000000000000000000000000000000000000001",
      stubDeps,
    )) as { balanceWei: string };
    expect(r.balanceWei).toBe("5000000000000000000");
  });
});
