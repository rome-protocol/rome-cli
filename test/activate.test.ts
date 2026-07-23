import { describe, it, expect, vi } from "vitest";
import { runActivate, readActivation, CCTP_BURN_RESERVE, type ActivateDeps } from "../src/core/activate.js";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";

// `rome activate` — one-time PDA funding for the first outbound bridge. A key-gated
// action (CLI-only, never MCP). Idempotent: skips (no spend) when already activated.
// The status check is a pure EVM read of the PDA lamports via `account_lamports`.

function deps(over: Partial<ActivateDeps>): ActivateDeps {
  return {
    address: "0xabc0000000000000000000000000000000000abc",
    pda: "PdA1111111111111111111111111111111111111111",
    readLamports: vi.fn(async () => 0n),
    getActivationCost: vi.fn(async () => 2n * 10n ** 18n),
    getPdaFunding: vi.fn(async () => 29_969_440n),
    activate: vi.fn(async () => ({ hash: "0xact" as `0x${string}`, success: true })),
    topUp: vi.fn(async () => ({ hash: "0xtop" as `0x${string}`, success: true })),
    ...over,
  };
}

describe("runActivate", () => {
  it("activates an unfunded PDA: read → cost → activate{value} → re-read lamports", async () => {
    const order: string[] = [];
    let reads = 0;
    const d = deps({
      readLamports: vi.fn(async () => {
        order.push("read");
        return reads++ === 0 ? 0n : 30_000_000n;
      }),
      getActivationCost: vi.fn(async () => (order.push("cost"), 2n * 10n ** 18n)),
      activate: vi.fn(async () => (order.push("activate"), { hash: "0xact" as `0x${string}`, success: true })),
    });
    const r = await runActivate(d);
    expect(order).toEqual(["read", "cost", "activate", "read"]);
    expect(r.alreadyActivated).toBe(false);
    expect(r.txHash).toBe("0xact");
    expect(r.cost).toBe((2n * 10n ** 18n).toString());
    expect(r.lamports).toBe("30000000");
  });

  it("skips with NO spend when already activated (lamports >= reserve)", async () => {
    const d = deps({ readLamports: vi.fn(async () => CCTP_BURN_RESERVE + 1n) });
    const r = await runActivate(d);
    expect(r.alreadyActivated).toBe(true);
    expect(d.getActivationCost).not.toHaveBeenCalled();
    expect(d.activate).not.toHaveBeenCalled();
    expect(d.topUp).not.toHaveBeenCalled();
  });

  it("DRAINED (0 < lamports < reserve): tops up via topUpUserPda, NEVER re-activate (it reverts AlreadyActivated)", async () => {
    let reads = 0;
    const d = deps({
      readLamports: vi.fn(async () => (reads++ === 0 ? 14_500_000n : 44_000_000n)),
    });
    const r = await runActivate(d);
    expect(d.activate).not.toHaveBeenCalled();
    expect(d.topUp).toHaveBeenCalledTimes(1);
    // tops back up to full funding: need = 29,969,440 - 14,500,000 lamports,
    // priced at the on-chain rate (activationCost / pdaFunding), rounded up.
    const [lamports, value] = (d.topUp as ReturnType<typeof vi.fn>).mock.calls[0] as [bigint, bigint];
    expect(lamports).toBe(29_969_440n - 14_500_000n);
    const expectedValue = (lamports * 2n * 10n ** 18n + 29_969_440n - 1n) / 29_969_440n;
    expect(value).toBe(expectedValue);
    expect(r.toppedUp).toBe(true);
    expect(r.txHash).toBe("0xtop");
    expect(r.lamports).toBe("44000000");
  });

  it("throws if the activation tx reverts", async () => {
    const d = deps({ activate: vi.fn(async () => ({ hash: "0xbad" as `0x${string}`, success: false })) });
    await expect(runActivate(d)).rejects.toThrow(/reverted/);
  });
});

describe("readActivation — pure EVM lamports read", () => {
  const PROG = "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf";
  const ADDR = "0x1Fc309eeF3D24dc2585aFb2175fAd4592f2a7b75" as const;

  it("activated=true when account_lamports >= reserve; queries the CPI precompile", async () => {
    const ethCall = vi.fn(async () => `0x${(20_000_000n).toString(16).padStart(64, "0")}` as `0x${string}`);
    const s = await readActivation(ADDR, PROG, ethCall);
    expect((ethCall.mock.calls[0][0] as string).toLowerCase()).toBe("0xff00000000000000000000000000000000000008");
    expect(s.activated).toBe(true);
    expect(s.lamports).toBe(20_000_000n);
    expect(s.pda).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58
  });

  it("activated=false when unfunded (0x / 0 lamports)", async () => {
    const s = await readActivation(ADDR, PROG, vi.fn(async () => "0x" as `0x${string}`));
    expect(s.lamports).toBe(0n);
    expect(s.activated).toBe(false);
  });
});

describe("activate is a key-gated action, never on MCP", () => {
  it("registered as an action requiring a key, and absent from the MCP surface", () => {
    const cap = CAPABILITIES.find((c) => c.id === "activate.activate");
    expect(cap?.kind).toBe("action");
    expect(cap?.requiresKey).toBe(true);
    expect(new Set(buildMcpTools().map((t) => t.name)).has("activate")).toBe(false);
  });
});
