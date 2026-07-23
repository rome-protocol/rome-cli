import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as realBridge from "@rome-protocol/sdk/bridge";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";
import {
  usdcBaseUnits,
  assetBaseUnits,
  resolveSourceChain,
  resolveBridgeBase,
  runInboundUsdc,
  runOutboundUsdc,
  bridgeHandler,
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
    outboundCctpQuoteRequest: realBridge.outboundCctpQuoteRequest,
    inboundWhQuoteRequest: realBridge.inboundWhQuoteRequest,
    outboundWhQuoteRequest: realBridge.outboundWhQuoteRequest,
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

// Outbound (from-rome): the user burns wUSDC on Rome (user-signed — NO settle, NO
// destination sponsor) → the engine registers + polls to attestation-ready → hands back
// a claim handle. Claiming on the destination is the USER's responsibility.
const DEST = { chainId: 84532, name: "Base Sepolia", rpcUrl: "https://sepolia.base.org" };

function cctpOutQuote() {
  return {
    route: "usdc-cctp-from-rome",
    direction: "from-rome" as const,
    amountIn: "1000000",
    amountOut: "1000000",
    fee: { bps: 0, absolute: "0", asset: "USDC" },
    etaSeconds: 90,
    steps: [
      {
        n: 1,
        chain: "rome-200010",
        kind: "cctp-burn-usdc",
        userSigns: true,
        unsignedTxs: [{ to: "0xBurn" as `0x${string}`, data: "0xburn" as `0x${string}`, description: "cctp burn wUSDC" }],
      },
      {
        n: 2,
        chain: "evm-84532",
        kind: "cctp-claim-on-destination",
        userSigns: true,
        unsignedTx: null,
        blockedBy: ["step-1", "circle-attestation"],
        claimTransmitter: "0xTransmitter",
        claimDomain: 6,
      },
    ],
  };
}

function mockSdkOut(quote: ReturnType<typeof cctpOutQuote>, order: string[], claimStatus: string) {
  return {
    inboundCctpQuoteRequest: realBridge.inboundCctpQuoteRequest,
    outboundCctpQuoteRequest: realBridge.outboundCctpQuoteRequest,
    inboundWhQuoteRequest: realBridge.inboundWhQuoteRequest,
    outboundWhQuoteRequest: realBridge.outboundWhQuoteRequest,
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
      return { id: "tr_out", route: "usdc-cctp-from-rome", outcome: "pending", steps: [] } as unknown as realBridge.TransferRecord;
    }),
    getTransfer: vi.fn(async () => {
      order.push("poll");
      return {
        id: "tr_out",
        route: "usdc-cctp-from-rome",
        outcome: "pending",
        steps: [{ n: 2, kind: "cctp-claim-on-destination", status: claimStatus }],
      } as unknown as realBridge.TransferRecord;
    }),
  };
}

describe("runOutboundUsdc — from-rome, user claims on destination", () => {
  let order: string[];
  beforeEach(() => {
    order = [];
  });

  it("quotes (from-rome) → signs the Rome burn → registers WITHOUT settle → polls to claim-ready → hands back the user-owned claim handle", async () => {
    const quote = cctpOutQuote();
    const sdk = mockSdkOut(quote, order, "ready");
    const signer = mockSigner(order);
    const res = await runOutboundUsdc({
      romeChainId: 200010,
      base: "https://bridge-api.example",
      romeRpcUrl: "https://rome.example",
      dest: DEST,
      amountBaseUnits: 1_000_000n,
      address: ADDR,
      deps: makeDeps(sdk, signer),
    });

    // one burn send, NO settle sign; register + poll
    expect(order).toEqual(["quote", "send", "register", "poll"]);
    expect(signer.signTypedData).not.toHaveBeenCalled();

    // requested from-rome for the right destination + amount
    const req = (sdk.requestQuote as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(req).toMatchObject({ asset: "USDC", direction: "from-rome", amount: "1000000", destinationChainId: 84532 });

    // register bound to the burn hash, WITHOUT a settle sig (outbound needs none)
    const regArg = (sdk.registerTransfer as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(regArg.step1TxHash).toBe("0xhash0");
    expect(regArg.userSettleSig).toBeUndefined();

    expect(res.dryRun).toBe(false);
    if (res.dryRun === false) {
      expect(res.transferId).toBe("tr_out");
      expect(res.burnTxHash).toBe("0xhash0");
      expect(res.destinationChainId).toBe(84532);
      expect(res.claim.yourResponsibility).toBe(true);
      expect(res.claim.status).toBe("ready");
      expect(res.claim.transmitter).toBe("0xTransmitter");
    }
  });

  it("refuses to sign a quote that isn't from-rome (direction guard)", async () => {
    const quote = { ...cctpOutQuote(), direction: "to-rome" as const };
    const sdk = mockSdkOut(quote, order, "ready");
    await expect(
      runOutboundUsdc({
        romeChainId: 200010,
        base: "b",
        romeRpcUrl: "r",
        dest: DEST,
        amountBaseUnits: 1_000_000n,
        address: ADDR,
        deps: makeDeps(sdk, mockSigner(order)),
      }),
    ).rejects.toThrow(/from-rome/);
  });

  it("dry-run quotes + plans the burn but signs/registers NOTHING", async () => {
    const quote = cctpOutQuote();
    const sdk = mockSdkOut(quote, order, "ready");
    const signer = mockSigner(order);
    const res = await runOutboundUsdc({
      romeChainId: 200010,
      base: "https://bridge-api.example",
      romeRpcUrl: "https://rome.example",
      dest: DEST,
      amountBaseUnits: 1_000_000n,
      address: ADDR,
      dryRun: true,
      deps: makeDeps(sdk, signer),
    });
    expect(order).toEqual(["quote"]);
    expect(signer.sendTx).not.toHaveBeenCalled();
    expect(sdk.registerTransfer).not.toHaveBeenCalled();
    expect(res.dryRun).toBe(true);
    if (res.dryRun === true) {
      expect(res.plannedTxs).toHaveLength(1);
      expect(res.route).toBe("usdc-cctp-from-rome");
    }
  });
});

// ── ETH (Wormhole) rails — the same engines, asset-parameterized ────────────
// In: eth-wormhole-to-rome (wrap+transfer on the source; the sponsor completes on
// Solana; lands as wETH; NO settle EIP-712). Out: eth-wormhole-from-rome (burn wETH
// on Rome — approve+burn, 2 user txs — then the USER claims on Ethereum).

function whInQuote() {
  return {
    route: "eth-wormhole-to-rome",
    direction: "to-rome" as const,
    amountIn: "2000000000000000",
    amountOut: "2000000000000000",
    fee: { bps: 0, absolute: "0", asset: "ETH" },
    etaSeconds: 900,
    steps: [
      {
        n: 1,
        chain: "ethereum",
        kind: "wormhole-wrap-and-transfer-eth",
        // NOTE: the live route-builder omits userSigns on this step — the SDK's
        // userSignedTxs collects by unsignedTxs presence, which this pins.
        unsignedTxs: [{ to: "0xWormhole" as `0x${string}`, data: "0xwrap" as `0x${string}`, value: "2000000000000000", description: "wrap + transfer ETH" }],
      },
      { n: 2, chain: "solana", kind: "wormhole-complete-transfer-wrapped", blockedBy: ["step-1", "wormhole-vaa"] },
    ],
  };
}

function whOutQuote() {
  return {
    route: "eth-wormhole-from-rome",
    direction: "from-rome" as const,
    amountIn: "2000000000000000",
    amountOut: "2000000000000000",
    fee: { bps: 0, absolute: "0", asset: "ETH" },
    etaSeconds: 900,
    steps: [
      {
        n: 1,
        chain: "rome-200010",
        kind: "wormhole-burn-eth",
        userSigns: true,
        unsignedTxs: [
          { to: "0xWETH" as `0x${string}`, data: "0xapprove" as `0x${string}`, description: "approve wETH" },
          { to: "0xWithdraw" as `0x${string}`, data: "0xburn" as `0x${string}`, description: "burn wETH via RomeBridgeWithdraw" },
        ],
      },
      { n: 2, chain: "ethereum", kind: "wormhole-claim-on-ethereum", userSigns: true, unsignedTx: null, blockedBy: ["step-1", "wormhole-vaa"] },
    ],
  };
}

describe("assetBaseUnits — per-asset decimals", () => {
  it("usdc = 6dp, eth = 18dp", () => {
    expect(assetBaseUnits("usdc", "1.5")).toBe(1_500_000n);
    expect(assetBaseUnits("eth", "0.002")).toBe(2_000_000_000_000_000n);
  });
  it("rejects an unknown asset and non-positive amounts", () => {
    expect(() => assetBaseUnits("doge" as never, "1")).toThrow(/asset/i);
    expect(() => assetBaseUnits("eth", "0")).toThrow();
  });
});

describe("runInboundUsdc — asset=eth (Wormhole in)", () => {
  it("uses the WH builder, collects the userSigns-less step-1 tx, registers WITHOUT settle", async () => {
    const order: string[] = [];
    const quote = whInQuote();
    const sdk = {
      ...mockSdk(quote as never, order),
      inboundWhQuoteRequest: realBridge.inboundWhQuoteRequest,
      outboundWhQuoteRequest: realBridge.outboundWhQuoteRequest,
    };
    const signer = mockSigner(order);
    const res = await runInboundUsdc({
      romeChainId: 200010,
      base: "https://bridge-api.example",
      source: { chainId: 11155111, name: "Sepolia", rpcUrl: "https://sepolia.example" },
      amountBaseUnits: 2_000_000_000_000_000n,
      address: ADDR,
      intent: "wrapper",
      asset: "eth",
      deps: makeDeps(sdk as never, signer),
    });
    // ONE source tx (the wrap+transfer), no settle signature, register → poll
    expect(order).toEqual(["quote", "send", "register", "poll"]);
    expect(signer.signTypedData).not.toHaveBeenCalled();
    const req = (sdk.requestQuote as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(req).toMatchObject({ asset: "ETH", direction: "to-rome" });
    const regArg = (sdk.registerTransfer as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(regArg.step1TxHash).toBe("0xhash0");
    expect(regArg.userSettleSig).toBeUndefined();
    if (res.dryRun === false) expect(res.settleAuthorized).toBe(false);
  });
});

describe("runOutboundUsdc — asset=eth (Wormhole out)", () => {
  it("uses the WH builder (no destinationChainId), burns 2 txs, detects the wormhole claim step", async () => {
    const order: string[] = [];
    const quote = whOutQuote();
    const sdk = {
      ...mockSdkOut(quote as never, order, "ready"),
      inboundWhQuoteRequest: realBridge.inboundWhQuoteRequest,
      outboundWhQuoteRequest: realBridge.outboundWhQuoteRequest,
      getTransfer: vi.fn(async () => {
        order.push("poll");
        return {
          id: "tr_out",
          route: "eth-wormhole-from-rome",
          outcome: "pending",
          steps: [{ n: 2, kind: "wormhole-claim-on-ethereum", status: "ready" }],
        } as unknown as realBridge.TransferRecord;
      }),
    };
    const signer = mockSigner(order);
    const res = await runOutboundUsdc({
      romeChainId: 200010,
      base: "https://bridge-api.example",
      romeRpcUrl: "https://rome.example",
      dest: { chainId: 11155111, name: "Sepolia", rpcUrl: "https://sepolia.example" },
      amountBaseUnits: 2_000_000_000_000_000n,
      address: ADDR,
      asset: "eth",
      deps: makeDeps(sdk as never, signer),
    });
    expect(order).toEqual(["quote", "send", "send", "register", "poll"]);
    const req = (sdk.requestQuote as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(req).toMatchObject({ asset: "ETH", direction: "from-rome" });
    expect(req.destinationChainId).toBeUndefined(); // WH: Ethereum only, no dest param
    if (res.dryRun === false) {
      expect(res.burnTxHash).toBe("0xhash1"); // last tx of the burn step (approve, then burn)
      expect(res.claim.status).toBe("ready");
      expect(res.claim.yourResponsibility).toBe(true);
    }
  });
});

describe("bridgeHandler — asset guards (fire before key/network)", () => {
  it("rejects an unknown --asset and eth-with-intent", async () => {
    await expect(bridgeHandler({ chain: "hadrian", from: "sepolia", amount: "1", asset: "doge" })).rejects.toThrow(/asset/i);
    await expect(bridgeHandler({ chain: "hadrian", from: "sepolia", amount: "0.002", asset: "eth", intent: "gas" })).rejects.toThrow(/intent/i);
  });
  it("rejects an ETH outbound destination that isn't the Ethereum rail", async () => {
    const prev = process.env.ROME_EVM_KEY;
    process.env.ROME_EVM_KEY = `0x${"11".repeat(32)}`;
    try {
      await expect(bridgeHandler({ chain: "hadrian", to: "base sepolia", amount: "0.002", asset: "eth" })).rejects.toThrow(/Ethereum/);
    } finally {
      if (prev !== undefined) process.env.ROME_EVM_KEY = prev;
      else delete process.env.ROME_EVM_KEY;
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
