import { describe, it, expect } from "vitest";
import { diagnoseTx, type RpcCall } from "../src/core/tx.js";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";

// `tx <hash>` — read-only cross-VM diagnosis: EVM receipt + the Solana settlement
// tx(s) via rome_solanaTxForEvmTx (Rome has no debug_trace*) + a Via explorer link.
// One injectable RpcCall (method,params)→result keeps it testable without a network.

const HASH = "0x8d993f2a9802ea0633a1e8d5fa32194f85524d9d6adc9332f41e2b82295c5d74";
const SOL = "5Lwke7W1w3nxrLNai4w7j5rFCMpVSYHffaJKTKC5231jgZVdgQF59ZnWNTxmMDPzAwuVuqTNgN9DRV8Pdxv1DNZU";

/** Build a mock RpcCall from a per-method response map. */
function mockCall(map: Record<string, unknown>): RpcCall {
  return async (method) => map[method];
}

describe("diagnoseTx — cross-VM tx diagnosis", () => {
  it("maps a confirmed EVM tx to its Solana settlement + a Via link", async () => {
    const call = mockCall({
      eth_getTransactionReceipt: { status: "0x1", gasUsed: "0x1607b0", blockNumber: "0x1c7a083d", from: "0xaa", to: "0xbb" },
      rome_solanaTxForEvmTx: [SOL],
    });
    const r = await diagnoseTx("hadrian", HASH, call);
    expect(r.status).toBe("success");
    expect(r.hash).toBe(HASH);
    expect(r.receipt?.gasUsed).toBe("0x1607b0");
    expect(r.solanaSettlement).toEqual([SOL]);
    expect(r.explorer).toContain(HASH);
  });

  it("reports a reverted tx", async () => {
    const call = mockCall({
      eth_getTransactionReceipt: { status: "0x0", gasUsed: "0x5208", blockNumber: "0x10", from: "0xaa", to: "0xbb" },
      rome_solanaTxForEvmTx: [SOL],
    });
    const r = await diagnoseTx("hadrian", HASH, call);
    expect(r.status).toBe("reverted");
  });

  it("reports pending when the receipt isn't indexed yet (settlement empty)", async () => {
    const call = mockCall({ eth_getTransactionReceipt: null, rome_solanaTxForEvmTx: [] });
    const r = await diagnoseTx("hadrian", HASH, call);
    expect(r.status).toBe("pending");
    expect(r.receipt).toBeNull();
    expect(r.solanaSettlement).toEqual([]);
  });

  it("tolerates rome_solanaTxForEvmTx being unavailable (returns [])", async () => {
    const call: RpcCall = async (m) => {
      if (m === "eth_getTransactionReceipt") return { status: "0x1", gasUsed: "0x1", blockNumber: "0x1", from: "0xaa", to: "0xbb" };
      throw new Error("method not found");
    };
    const r = await diagnoseTx("hadrian", HASH, call);
    expect(r.status).toBe("success");
    expect(r.solanaSettlement).toEqual([]);
  });
});

describe("tx is a read capability, on MCP", () => {
  it("registered as a read verb and present on the MCP surface", () => {
    const cap = CAPABILITIES.find((c) => c.id === "tx.tx");
    expect(cap?.kind).toBe("read");
    expect(cap?.requiresKey).toBe(false);
    expect(new Set(buildMcpTools().map((t) => t.name)).has("tx")).toBe(true);
  });
});
