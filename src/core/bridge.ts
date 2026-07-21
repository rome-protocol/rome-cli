import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getBridge } from "@rome-protocol/registry";
import * as bridgeSdk from "@rome-protocol/sdk/bridge";
import type { SettleTypedData, TransferRecord, UnsignedTx, FlowStatus } from "@rome-protocol/sdk/bridge";
import { resolveChainId } from "./facts.js";
import { requireEvmKey } from "./keys.js";

// ── Fund / bridge: the "from home" on-ramp ──────────────────────────────────
// One rail-agnostic INBOUND flow engine that ORCHESTRATES @rome-protocol/sdk/bridge
// (the SDK owns the protocol; the CLI owns the source-chain signing the SDK leaves
// to the client). `fund` = the opinionated USDC→gas front door; `bridge` = the same
// engine with the intent knob (gas | wrapper). Everything is sourced from the
// registry (source chains + RPCs) — no hardcoded chain data.

/** The subset of the bridge SDK the engine calls — an interface so tests inject a mock. */
export interface BridgeSdk {
  inboundCctpQuoteRequest: typeof bridgeSdk.inboundCctpQuoteRequest;
  userSignedTxs: typeof bridgeSdk.userSignedTxs;
  step1BindingTxIndex: typeof bridgeSdk.step1BindingTxIndex;
  settleTypedDataWithBurn: typeof bridgeSdk.settleTypedDataWithBurn;
  transferFlowStatus: typeof bridgeSdk.transferFlowStatus;
  requestQuote: typeof bridgeSdk.requestQuote;
  registerTransfer: typeof bridgeSdk.registerTransfer;
  getTransfer: typeof bridgeSdk.getTransfer;
}

/** Signs + broadcasts source-chain txs and the settle authorization. Injectable. */
export interface EvmSigner {
  address: `0x${string}`;
  /** Broadcast a source-chain tx, wait for its receipt, return the hash. */
  sendTx(tx: UnsignedTx): Promise<`0x${string}`>;
  /** Sign the trustless-settle EIP-712 (gas intent only). */
  signTypedData(td: SettleTypedData): Promise<`0x${string}`>;
}

export interface BridgeDeps {
  sdk: BridgeSdk;
  makeSigner: (rpcUrl: string) => EvmSigner;
  sleep: (ms: number) => Promise<void>;
}

/** Real deps: the SDK + a viem signer built from ROME_EVM_KEY. */
export function defaultBridgeDeps(): BridgeDeps {
  return {
    sdk: bridgeSdk,
    makeSigner: realSigner,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function realSigner(rpcUrl: string): EvmSigner {
  const account = privateKeyToAccount(requireEvmKey());
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, transport: http(rpcUrl) });
  return {
    address: account.address,
    async sendTx(tx) {
      // Source-chain txs are plain EVM (not Rome) — sign + broadcast directly, then
      // wait for the receipt so the next tx (e.g. burn after approve) sees the effect.
      const id = await pub.getChainId();
      const hash = await wallet.sendTransaction({
        account,
        to: tx.to,
        data: tx.data,
        value: tx.value !== undefined ? BigInt(tx.value) : 0n,
        chain: {
          id,
          name: `chain-${id}`,
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: { default: { http: [rpcUrl] } },
        },
      });
      await pub.waitForTransactionReceipt({ hash });
      return hash;
    },
    async signTypedData(td) {
      // viem rebuilds the EIP712Domain type from `domain`; drop it from `types`.
      const { EIP712Domain: _omit, ...types } = td.types as Record<string, unknown>;
      const typedData = { domain: td.domain, types, primaryType: td.primaryType, message: td.message };
      return account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]);
    },
  };
}

// ── Resolvers (chain-first, from registry bridge config) ────────────────────

export interface SourceChain {
  chainId: number;
  name: string;
  rpcUrl: string;
}

interface BridgeCfg {
  sourceEvm?: SourceChain;
  sourceEvms?: SourceChain[];
}

function bridgeCfg(romeChain: string | number): BridgeCfg {
  const id = resolveChainId(romeChain);
  const cfg = getBridge(id) as BridgeCfg | undefined;
  if (!cfg) throw new Error(`No bridge configuration for Rome chain ${id}.`);
  return cfg;
}

function sourceList(cfg: BridgeCfg): SourceChain[] {
  const all = [...(cfg.sourceEvm ? [cfg.sourceEvm] : []), ...(cfg.sourceEvms ?? [])];
  const byId = new Map<number, SourceChain>();
  for (const s of all) {
    if (!byId.has(s.chainId)) byId.set(s.chainId, { chainId: s.chainId, name: s.name, rpcUrl: s.rpcUrl });
  }
  return [...byId.values()];
}

/** Resolve a CCTP source chain (id, name, or hyphen-slug) to its registry entry. */
export function resolveSourceChain(romeChain: string | number, input: string | number): SourceChain {
  const list = sourceList(bridgeCfg(romeChain));
  const q = String(input).trim().toLowerCase();
  const match = list.find(
    (s) => s.chainId === Number(q) || s.name.toLowerCase() === q || s.name.toLowerCase().replace(/\s+/g, "-") === q,
  );
  if (!match) {
    const known = list.map((s) => `${s.chainId} (${s.name})`).join(", ");
    throw new Error(`Unsupported bridge source "${input}". Supported sources: ${known}.`);
  }
  return match;
}

// The Rome bridge-api orchestrator base is NOT in the public registry projection yet;
// resolve --bridge-api > ROME_BRIDGE_API > a devnet default (both public chains are
// devnet). FOLLOW-UP (structural): add `apiBase` to registry bridge.json so this is
// chain-first like everything else.
const DEVNET_BRIDGE_API = "https://bridge-api.devnet.romeprotocol.xyz";

/** The bridge-api base (root; the SDK appends `/v1/...`). Never ends in `/` or `/v1`. */
export function resolveBridgeBase(_romeChain: string | number, override?: string): string {
  const pick = override ?? process.env.ROME_BRIDGE_API ?? DEVNET_BRIDGE_API;
  return pick.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Human USDC (6 decimals) → base units. Rejects non-positive / malformed. */
export function usdcBaseUnits(human: string): bigint {
  const v = parseUnits(String(human).trim() as `${number}`, 6);
  if (v <= 0n) throw new Error(`Amount must be a positive USDC value (got "${human}").`);
  return v;
}

// ── The inbound flow engine ─────────────────────────────────────────────────

export type InboundIntent = "gas" | "wrapper";

export interface InboundUsdcParams {
  romeChainId: number;
  base: string;
  source: SourceChain;
  amountBaseUnits: bigint;
  address: `0x${string}`;
  intent: InboundIntent;
  dryRun?: boolean;
  pollMax?: number;
  pollIntervalMs?: number;
  deps: BridgeDeps;
}

export type InboundResult =
  | {
      dryRun: true;
      route: string;
      amountIn: string;
      amountOut: string;
      fee?: unknown;
      etaSeconds?: number;
      plannedTxs: Array<{ stepN: number; to: string; description?: string }>;
    }
  | {
      dryRun: false;
      transferId: string;
      route: string;
      outcome: string;
      flow: FlowStatus;
      step1TxHash: string;
      sourceTxHashes: string[];
      settleAuthorized: boolean;
    };

export async function runInboundUsdc(p: InboundUsdcParams): Promise<InboundResult> {
  const { sdk } = p.deps;
  const opts = { base: p.base };

  // 1. build the request (gas builder; override intent for wrapper) → quote
  const req = sdk.inboundCctpQuoteRequest({
    sourceChainId: p.source.chainId,
    romeChainId: p.romeChainId,
    amount: p.amountBaseUnits,
    evmAddress: p.address,
  });
  if (p.intent === "wrapper") req.intent = "wrapper";
  const quote = await sdk.requestQuote(req, opts);

  // guard: never sign a quote that isn't the inbound flow we asked for
  if (quote.direction !== "to-rome") {
    throw new Error(`Bridge quote direction "${quote.direction}" != "to-rome"; refusing to sign.`);
  }

  const signed = sdk.userSignedTxs(quote, quote.route);

  if (p.dryRun) {
    return {
      dryRun: true,
      route: quote.route,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      fee: quote.fee,
      etaSeconds: quote.etaSeconds,
      plannedTxs: signed.map((s) => ({ stepN: s.stepN, to: s.tx.to, description: s.tx.description })),
    };
  }

  // 2. sign + broadcast the source txs, in order
  const signer = p.deps.makeSigner(p.source.rpcUrl);
  const sourceTxHashes: string[] = [];
  for (const item of signed) sourceTxHashes.push(await signer.sendTx(item.tx));

  // 3. bind registration to the burn (last tx of the first step)
  const step1TxHash = sourceTxHashes[sdk.step1BindingTxIndex(signed)];

  // 4. gas-intent CCTP → sign the trustless-settle authorization with the burn hash
  const td = sdk.settleTypedDataWithBurn(quote, step1TxHash);
  const userSettleSig = td ? await signer.signTypedData(td) : undefined;

  // 5. register, then poll to a terminal outcome
  const record = await sdk.registerTransfer({ quote, step1TxHash, userSettleSig }, opts);
  const final = await pollTransfer(sdk, record.id, record, opts, p.deps.sleep, p.pollMax ?? 40, p.pollIntervalMs ?? 3000);

  return {
    dryRun: false,
    transferId: record.id,
    route: quote.route,
    outcome: final.outcome,
    flow: sdk.transferFlowStatus(final),
    step1TxHash,
    sourceTxHashes,
    settleAuthorized: userSettleSig !== undefined,
  };
}

async function pollTransfer(
  sdk: BridgeSdk,
  id: string,
  first: TransferRecord,
  opts: { base: string },
  sleep: (ms: number) => Promise<void>,
  max: number,
  intervalMs: number,
): Promise<TransferRecord> {
  let rec = first;
  for (let i = 0; i < max; i++) {
    if (rec.outcome === "complete" || rec.outcome === "failed") return rec;
    await sleep(intervalMs);
    rec = await sdk.getTransfer(id, opts);
  }
  return rec;
}

// ── Capability handlers (CLI-only; key from env; never MCP) ──────────────────

function requireArg(args: Record<string, string>, name: string): string {
  const v = args[name];
  if (v === undefined || v === "") throw new Error(`Missing required --${name}.`);
  return v;
}

async function inboundHandler(args: Record<string, string>, intent: InboundIntent): Promise<InboundResult> {
  const romeChainId = resolveChainId(args.chain);
  const source = resolveSourceChain(romeChainId, requireArg(args, "from"));
  const amountBaseUnits = usdcBaseUnits(requireArg(args, "amount"));
  const base = resolveBridgeBase(romeChainId, args["bridge-api"]);
  const dryRun = args["dry-run"] === "true";
  // Key FIRST (fail fast, no network): derive the actor address for the quote.
  const address = privateKeyToAccount(requireEvmKey()).address;
  return runInboundUsdc({ romeChainId, base, source, amountBaseUnits, address, intent, dryRun, deps: defaultBridgeDeps() });
}

/** `rome fund <chain> --from <source> --amount <usdc>` — USDC → Rome gas (CCTP). */
export function fundHandler(args: Record<string, string>): Promise<InboundResult> {
  return inboundHandler(args, "gas");
}

/** `rome bridge <chain> --from <source> --amount <usdc> [--intent gas|wrapper]`. */
export function bridgeHandler(args: Record<string, string>): Promise<InboundResult> {
  const intent = (args.intent ?? "gas").toLowerCase();
  if (intent !== "gas" && intent !== "wrapper") {
    throw new Error(`--intent must be "gas" or "wrapper" (got "${args.intent}").`);
  }
  return inboundHandler(args, intent as InboundIntent);
}
