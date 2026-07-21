import { describe, it, expect, vi } from "vitest";
import { runVerifySolidity, verifyHandler, type VerifyDeps } from "../src/core/verify.js";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";

// `verify --path solidity` — the both-lane works-gate: deploy a probe, drive set/get
// from the EVM lane (submitRomeTx) AND the Solana lane (submitRomeTxSolanaLane), assert
// the SAME contract answers on each. A funded ACTION (both keys); CLI-only, never MCP.
// These tests pin the orchestration + parity logic with mocked lane ops (no network).

function deps(reads: bigint[], order: string[]): VerifyDeps {
  let i = 0;
  return {
    deployProbe: vi.fn(async () => {
      order.push("deploy");
      return "0xprobe00000000000000000000000000000000abcd" as `0x${string}`;
    }),
    evmLaneSet: vi.fn(async () => void order.push("evmSet")),
    solanaLaneSet: vi.fn(async () => void order.push("solanaSet")),
    read: vi.fn(async () => {
      order.push("read");
      return reads[i++];
    }),
  };
}

describe("runVerifySolidity — both-lane works-gate", () => {
  it("GREEN when both lanes drive the same contract (deploy → evm set/read → solana set/read)", async () => {
    const order: string[] = [];
    const r = await runVerifySolidity(deps([42n, 43n], order));
    expect(order).toEqual(["deploy", "evmSet", "read", "solanaSet", "read"]);
    expect(r.ok).toBe(true);
    expect(r.probe).toMatch(/^0x/);
    expect(r.checks.map((c) => [c.lane, c.ok])).toEqual([
      ["evm", true],
      ["solana", true],
    ]);
  });

  it("RED when the EVM lane write doesn't land", async () => {
    const r = await runVerifySolidity(deps([0n, 43n], []));
    expect(r.checks.find((c) => c.lane === "evm")?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("RED when the Solana lane write doesn't land", async () => {
    const r = await runVerifySolidity(deps([42n, 42n], []));
    expect(r.checks.find((c) => c.lane === "solana")?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });
});

describe("verify is a key-gated action, never on MCP", () => {
  it("registered as an action requiring a key, and absent from the MCP surface", () => {
    const cap = CAPABILITIES.find((c) => c.id === "verify.verify");
    expect(cap?.kind).toBe("action");
    expect(cap?.requiresKey).toBe(true);
    expect(cap?.verb).toBe(true);
    expect(new Set(buildMcpTools().map((t) => t.name)).has("verify")).toBe(false);
  });

  it("refuses without keys before any network call", async () => {
    const pe = process.env.ROME_EVM_KEY;
    const ps = process.env.ROME_SOLANA_KEY;
    delete process.env.ROME_EVM_KEY;
    delete process.env.ROME_SOLANA_KEY;
    try {
      await expect(verifyHandler({ chain: "hadrian", path: "solidity" })).rejects.toThrow(/ROME_(EVM|SOLANA)_KEY/);
    } finally {
      if (pe !== undefined) process.env.ROME_EVM_KEY = pe;
      if (ps !== undefined) process.env.ROME_SOLANA_KEY = ps;
    }
  });
});
