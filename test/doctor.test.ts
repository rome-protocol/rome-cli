import { describe, it, expect } from "vitest";
import { doctor } from "../src/core/doctor.js";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";
import type { Deps, RpcClient } from "../src/core/deps.js";

// `doctor` is a read-only preflight: chain live? RPC reachable? program configured?
// wallet funded (optional address)? It composes registry facts + a live RPC ping, so
// it's on BOTH the CLI and MCP. No key — the funded check takes a plain address.

function depsWith(rpc: Partial<RpcClient>): Deps {
  return {
    makeRpc: () => ({
      getGasPrice: rpc.getGasPrice ?? (async () => 10n),
      getBalance: rpc.getBalance ?? (async () => 0n),
    }),
  };
}
const check = (r: Awaited<ReturnType<typeof doctor>>, name: string) => r.checks.find((c) => c.name === name);

describe("doctor — preflight", () => {
  it("all green on a live chain with a reachable RPC", async () => {
    const r = await doctor("hadrian", undefined, depsWith({ getGasPrice: async () => 10_000n }));
    expect(r.chain.id).toBe(200010);
    expect(check(r, "chain-live")?.ok).toBe(true);
    expect(check(r, "rpc-reachable")?.ok).toBe(true);
    expect(check(r, "program-configured")?.ok).toBe(true);
    // no address → no wallet-funded check
    expect(check(r, "wallet-funded")).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("flags an unreachable RPC (ping throws) and fails overall", async () => {
    const r = await doctor("hadrian", undefined, depsWith({ getGasPrice: async () => { throw new Error("ECONNREFUSED"); } }));
    expect(check(r, "rpc-reachable")?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("adds a wallet-funded check when an address is given", async () => {
    const funded = await doctor("hadrian", "0x1Fc309eeF3D24dc2585aFb2175fAd4592f2a7b75", depsWith({ getBalance: async () => 5n }));
    expect(check(funded, "wallet-funded")?.ok).toBe(true);
    const empty = await doctor("hadrian", "0x1Fc309eeF3D24dc2585aFb2175fAd4592f2a7b75", depsWith({ getBalance: async () => 0n }));
    expect(check(empty, "wallet-funded")?.ok).toBe(false);
    expect(empty.ok).toBe(false);
  });

  it("errors clearly on an unknown chain", async () => {
    await expect(doctor("nope-chain", undefined, depsWith({}))).rejects.toThrow(/unknown chain/i);
  });
});

describe("doctor is a read capability, exposed on MCP", () => {
  it("registered as a read verb and present on the MCP surface", () => {
    const cap = CAPABILITIES.find((c) => c.id === "doctor.doctor");
    expect(cap?.kind).toBe("read");
    expect(cap?.requiresKey).toBe(false);
    expect(cap?.verb).toBe(true);
    expect(new Set(buildMcpTools().map((t) => t.name)).has("doctor")).toBe(true);
  });
});
