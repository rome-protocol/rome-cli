import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as realBridge from "@rome-protocol/sdk/bridge";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";
import {
  usdcBaseUnits,
  resolveSourceChain,
  resolveBridgeBase,
  runInboundUsdc,
  type BridgeDeps,
  type EvmSigner,
} from "../src/core/bridge.js";

// Phase 2 (inbound funding): `fund` + `bridge` are ACTIONS — CLI-only, key-gated,
// never on MCP. The flow engine orchestrates @rome-protocol/sdk/bridge; these tests
// pin the orchestration ORDER + arguments against the REAL SDK helper semantics,
// mocking only the network calls (requestQuote/registerTransfer/getTransfer) + signer.

const ADDR = "0xB14B4A0c3b64d22bad40f7848F5fBe7C515D4753" as const;

/** A realistic CCTP-in quote: step 1 = [approve, depositForBurn] on the source chain,
 *  plus a settle-authorization (gas intent). */
function cctpInQuote(withSettle: boolean) {
  return {
    route: "cctp-in",
    direction: "to-rome" as const,
    amountIn: "1000000",
    amountOut: "990000",
    fee: { bps: 10, absolute: "10000", asset: "USDC" },
    etaSeconds: 30,
    steps: [
      {
        n: 1,
        chain: "source",
        kind: "cctp-burn",
        userSigns: true,
        unsignedTxs: [
          { to: "0xUSDC" as `0x${string}`, data: "0xapprove" as `0x${string}`, description: "approve USDC" },
          { to: "0xTokenMessenger" as `0x${string}`, data: "0xburn" as `0x${string}`, description: "depositForBurn" },
        ],
      },
      { n: 2, chain: "rome", kind: "settle-inbound-bridge-sponsored", sponsor: "rome", blockedBy: ["circle-attestation"] },
    ],
    ...(withSettle
      ? {
          signatureRequests: [
            {
              kind: "settle-authorization-eip712",
              fillFromBurn: "sourceTxHash",
              typedData: {
                domain: { name: "RomeBridge", version: "1", chainId: 200010 },
                types: { SettleAuthorization: [{ name: "sourceTxHash", type: "string" }] },
                primaryType: "SettleAuthorization",
                message: { recipient: ADDR },
              },
            },
          ],
        }
      : {}),
  };
}

/** SDK mock: REAL helper logic (userSignedTxs, step1BindingTxIndex, settleTypedDataWithBurn,
 *  transferFlowStatus, inboundCctpQuoteRequest) + spied network fns. */
function mockSdk(quote: ReturnType<typeof cctpInQuote>, order: string[]) {
  return {
    inboundCctpQuoteRequest: realBridge.inboundCctpQuoteRequest,
    userSignedTxs: realBridge.userSignedTxs,
    step1BindingTxIndex: realBridge.step1BindingTxIndex,
    settleTypedDataWithBurn: realBridge.settleTypedDataWithBurn,
    transferFlowStatus: realBridge.transferFlowStatus,
    requestQuote: vi.fn(async () => {
      order.push("quote");
      return quote as unknown as realBridge.Quote;
    }),
    registerTransfer: vi.fn(async (_p: unknown) => {
      order.push("register");
      return { id: "tr_1", route: "cctp-in", outcome: "pending", steps: [] } as unknown as realBridge.TransferRecord;
    }),
    getTransfer: vi.fn(async () => {
      order.push("poll");
      return {
        id: "tr_1",
        route: "cctp-in",
        outcome: "complete",
        steps: [{ n: 2, kind: "settle-inbound-bridge-sponsored", status: "confirmed" }],
      } as unknown as realBridge.TransferRecord;
    }),
  };
}

function mockSigner(order: string[]): EvmSigner & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    address: ADDR,
    sendTx: vi.fn(async (tx: unknown) => {
      order.push("send");
      sent.push(tx);
      return `0xhash${sent.length - 1}` as `0x${string}`;
    }),
    signTypedData: vi.fn(async () => {
      order.push("settle");
      return "0xsig" as `0x${string}`;
    }),
  };
}

function makeDeps(sdk: ReturnType<typeof mockSdk>, signer: EvmSigner): BridgeDeps {
  return { sdk, makeSigner: () => signer, sleep: async () => {} };
}

const SOURCE = { chainId: 84532, name: "Base Sepolia", rpcUrl: "https://sepolia.base.org" };

describe("capability wiring: fund + bridge are CLI-only key-gated actions", () => {
  it("fund + bridge exist as verb actions requiring a key", () => {
    const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));
    for (const id of ["fund.fund", "bridge.bridge"]) {
      const c = byId.get(id);
      expect(c, id).toBeTruthy();
      expect(c!.kind).toBe("action");
      expect(c!.requiresKey).toBe(true);
      expect(c!.verb).toBe(true);
    }
  });
  it("neither fund nor bridge is exposed on the MCP surface", () => {
    const tools = new Set(buildMcpTools().map((t) => t.name));
    expect(tools.has("fund")).toBe(false);
    expect(tools.has("bridge")).toBe(false);
  });
});

describe("usdcBaseUnits (6 decimals)", () => {
  it("converts human USDC to base units", () => {
    expect(usdcBaseUnits("1")).toBe(1_000_000n);
    expect(usdcBaseUnits("1.5")).toBe(1_500_000n);
    expect(usdcBaseUnits("0.000001")).toBe(1n);
  });
  it("rejects non-positive / malformed amounts", () => {
    expect(() => usdcBaseUnits("0")).toThrow();
    expect(() => usdcBaseUnits("-1")).toThrow();
    expect(() => usdcBaseUnits("abc")).toThrow();
  });
});

describe("resolveSourceChain (chain-first, from registry bridge config)", () => {
  it("resolves a supported source by id, name, or slug", () => {
    expect(resolveSourceChain(200010, "84532").chainId).toBe(84532);
    expect(resolveSourceChain(200010, "base sepolia").chainId).toBe(84532);
    expect(resolveSourceChain(200010, "Sepolia").chainId).toBe(11155111);
    expect(resolveSourceChain(200010, "base sepolia").rpcUrl).toMatch(/^https?:\/\//);
  });
  it("throws with the known source list for an unsupported source", () => {
    expect(() => resolveSourceChain(200010, "mainnet-eth")).toThrow(/source/i);
  });
});

describe("resolveBridgeBase (flag > env > default; root, no /v1)", () => {
  const prev = process.env.ROME_BRIDGE_API;
  afterEach(() => {
    if (prev === undefined) delete process.env.ROME_BRIDGE_API;
    else process.env.ROME_BRIDGE_API = prev;
  });
  it("prefers an explicit override", () => {
    expect(resolveBridgeBase(200010, "https://custom.example")).toBe("https://custom.example");
  });
  it("falls back to env, then a devnet default; never ends in /v1", () => {
    process.env.ROME_BRIDGE_API = "https://env.example";
    expect(resolveBridgeBase(200010)).toBe("https://env.example");
    delete process.env.ROME_BRIDGE_API;
    const def = resolveBridgeBase(200010);
    expect(def).toMatch(/^https:\/\//);
    expect(def.endsWith("/v1")).toBe(false);
    expect(def.endsWith("/")).toBe(false);
  });
});

describe("runInboundUsdc — the flow engine (gas intent)", () => {
  let order: string[];
  beforeEach(() => {
    order = [];
  });

  it("quotes → signs both source txs → signs settle → registers with the burn hash → polls to complete", async () => {
    const quote = cctpInQuote(true);
    const sdk = mockSdk(quote, order);
    const signer = mockSigner(order);
    const res = await runInboundUsdc({
      romeChainId: 200010,
      base: "https://bridge-api.example",
      source: SOURCE,
      amountBaseUnits: 1_000_000n,
      address: ADDR,
      intent: "gas",
      deps: makeDeps(sdk, signer),
    });

    // orchestration order: quote, then TWO source sends, then settle-sign, then register, then poll
    expect(order).toEqual(["quote", "send", "send", "settle", "register", "poll"]);

    // the quote request is a gas-intent USDC to-rome for the right sender/amount
    const req = (sdk.requestQuote as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(req).toMatchObject({ asset: "USDC", direction: "to-rome", intent: "gas", amount: "1000000" });
    expect((req.sender as Record<string, string>).ethereum).toBe(ADDR);

    // both source txs broadcast, in order
    expect(signer.sendTx).toHaveBeenCalledTimes(2);

    // register bound to the LAST tx of the first step (the burn) = 0xhash1, with the settle sig
    const regArg = (sdk.registerTransfer as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(regArg.step1TxHash).toBe("0xhash1");
    expect(regArg.userSettleSig).toBe("0xsig");

    expect(res.dryRun).toBe(false);
    if (res.dryRun === false) {
      expect(res.transferId).toBe("tr_1");
      expect(res.outcome).toBe("complete");
      expect(res.sourceTxHashes).toEqual(["0xhash0", "0xhash1"]);
      expect(res.settleAuthorized).toBe(true);
    }
  });

  it("wrapper intent (no settle authorization) registers WITHOUT a settle sig and never signs typed data", async () => {
    const quote = cctpInQuote(false); // no signatureRequests → settleTypedDataWithBurn === null
    const sdk = mockSdk(quote, order);
    const signer = mockSigner(order);
    const res = await runInboundUsdc({
      romeChainId: 200010,
      base: "https://bridge-api.example",
      source: SOURCE,
      amountBaseUnits: 1_000_000n,
      address: ADDR,
      intent: "wrapper",
      deps: makeDeps(sdk, signer),
    });

    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(order).toEqual(["quote", "send", "send", "register", "poll"]);
    const req = (sdk.requestQuote as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(req.intent).toBe("wrapper");
    const regArg = (sdk.registerTransfer as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(regArg.userSettleSig).toBeUndefined();
    if (res.dryRun === false) expect(res.settleAuthorized).toBe(false);
  });

  it("dry-run quotes + plans the source txs but signs/broadcasts/registers NOTHING", async () => {
    const quote = cctpInQuote(true);
    const sdk = mockSdk(quote, order);
    const signer = mockSigner(order);
    const res = await runInboundUsdc({
      romeChainId: 200010,
      base: "https://bridge-api.example",
      source: SOURCE,
      amountBaseUnits: 1_000_000n,
      address: ADDR,
      intent: "gas",
      dryRun: true,
      deps: makeDeps(sdk, signer),
    });

    expect(order).toEqual(["quote"]);
    expect(signer.sendTx).not.toHaveBeenCalled();
    expect(sdk.registerTransfer).not.toHaveBeenCalled();
    expect(res.dryRun).toBe(true);
    if (res.dryRun === true) {
      expect(res.plannedTxs).toHaveLength(2);
      expect(res.route).toBe("cctp-in");
    }
  });
});

describe("action key-gating (fund/bridge refuse without a key, before any network call)", () => {
  it("the fund capability handler throws /ROME_EVM_KEY/ when unset", async () => {
    const prev = process.env.ROME_EVM_KEY;
    delete process.env.ROME_EVM_KEY;
    try {
      const fund = CAPABILITIES.find((c) => c.id === "fund.fund")!;
      await expect(
        Promise.resolve(fund.handler({ chain: "hadrian", from: "base sepolia", amount: "0.01" })),
      ).rejects.toThrow(/ROME_EVM_KEY/);
    } finally {
      if (prev !== undefined) process.env.ROME_EVM_KEY = prev;
    }
  });
});
