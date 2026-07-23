import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getBridge } from "@rome-protocol/registry";
import * as bridgeSdk from "@rome-protocol/sdk/bridge";
import type { SettleTypedData, TransferRecord, UnsignedTx, FlowStatus } from "@rome-protocol/sdk/bridge";
import { resolveChainId, getChainFacts } from "./facts.js";
import { requireEvmKey } from "./keys.js";
import { readActivation, notActivatedError } from "./activate.js";

// ── Fund / bridge: the "from home" on-ramp ──────────────────────────────────
// One rail-agnostic INBOUND flow engine that ORCHESTRATES @rome-protocol/sdk/bridge
// (the SDK owns the protocol; the CLI owns the source-chain signing the SDK leaves
// to the client). `fund` = the opinionated USDC→gas front door; `bridge` = the same
// engine with the intent knob (gas | wrapper). Everything is sourced from the
// registry (source chains + RPCs) — no hardcoded chain data.

/** The subset of the bridge SDK the engine calls — an interface so tests inject a mock. */
export interface BridgeSdk {
  inboundCctpQuoteRequest: typeof bridgeSdk.inboundCctpQuoteRequest;
  outboundCctpQuoteRequest: typeof bridgeSdk.outboundCctpQuoteRequest;
  inboundWhQuoteRequest: typeof bridgeSdk.inboundWhQuoteRequest;
  outboundWhQuoteRequest: typeof bridgeSdk.outboundWhQuoteRequest;
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

// ── Assets: USDC rides CCTP; ETH rides Wormhole (in → wETH on Rome; out → Ethereum) ──
export type BridgeAsset = "usdc" | "eth";
const ASSET_DECIMALS: Record<BridgeAsset, number> = { usdc: 6, eth: 18 };

/** Human amount → base units for the asset. Rejects unknown assets / non-positive. */
export function assetBaseUnits(asset: BridgeAsset, human: string): bigint {
  const dp = ASSET_DECIMALS[asset];
  if (dp === undefined) throw new Error(`Unknown asset "${asset}" (supported: usdc, eth).`);
  const v = parseUnits(String(human).trim() as `${number}`, dp);
  if (v <= 0n) throw new Error(`Amount must be a positive ${asset.toUpperCase()} value (got "${human}").`);
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
  /** usdc (default, CCTP) | eth (Wormhole → wETH on Rome; no intent, no settle). */
  asset?: BridgeAsset;
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

  // 1. build the request → quote. USDC rides CCTP (gas builder; wrapper overrides the
  // intent); ETH rides Wormhole (no intent — it always lands as wETH, never gas).
  const req =
    (p.asset ?? "usdc") === "eth"
      ? sdk.inboundWhQuoteRequest({
          sourceChainId: p.source.chainId,
          romeChainId: p.romeChainId,
          amount: p.amountBaseUnits,
          evmAddress: p.address,
        })
      : sdk.inboundCctpQuoteRequest({
          sourceChainId: p.source.chainId,
          romeChainId: p.romeChainId,
          amount: p.amountBaseUnits,
          evmAddress: p.address,
        });
  if ((p.asset ?? "usdc") === "usdc" && p.intent === "wrapper") req.intent = "wrapper";
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

// ── The outbound flow engine (from-rome) ────────────────────────────────────
// The user burns wUSDC ON ROME (user-signed). Rome runs a sponsor for the *inbound*
// settle intent, but outbound carries NO settle and NO destination sponsor — claiming
// on the destination (a standard CCTP receiveMessage) is the USER's responsibility. We
// orchestrate the Rome side (burn → register → poll to attestation-ready) and hand back
// a claim handle.

export interface OutboundUsdcParams {
  romeChainId: number;
  base: string;
  romeRpcUrl: string;
  dest: SourceChain;
  amountBaseUnits: bigint;
  address: `0x${string}`;
  recipient?: `0x${string}`;
  /** usdc (default, CCTP any catalog dest) | eth (Wormhole → Ethereum only). */
  asset?: BridgeAsset;
  dryRun?: boolean;
  pollMax?: number;
  pollIntervalMs?: number;
  deps: BridgeDeps;
}

export interface OutboundClaimHandle {
  /** Claiming on the destination is the user's responsibility — Rome does not sponsor it. */
  yourResponsibility: true;
  status: string;
  transmitter?: string;
  domain?: number;
  note: string;
}

export type OutboundResult =
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
      burnTxHash: string;
      destinationChainId: number;
      claim: OutboundClaimHandle;
    };

// Both rails' destination step carries "claim" in its kind (cctp-claim-on-destination,
// wormhole-claim-on-ethereum) — the user-owned leg is detected by that, rail-agnostic.
const isClaimKind = (k: string | undefined) => Boolean(k && /claim/.test(k));

export async function runOutboundUsdc(p: OutboundUsdcParams): Promise<OutboundResult> {
  const { sdk } = p.deps;
  const opts = { base: p.base };

  // USDC rides CCTP (per-call destination); ETH rides Wormhole (Ethereum only — the
  // builder takes no destination).
  const req =
    (p.asset ?? "usdc") === "eth"
      ? sdk.outboundWhQuoteRequest({
          romeChainId: p.romeChainId,
          amount: p.amountBaseUnits,
          evmAddress: p.address,
          recipient: p.recipient ?? p.address,
        })
      : sdk.outboundCctpQuoteRequest({
          destinationChainId: p.dest.chainId,
          romeChainId: p.romeChainId,
          amount: p.amountBaseUnits,
          evmAddress: p.address,
          recipient: p.recipient ?? p.address,
        });
  const quote = await sdk.requestQuote(req, opts);

  // guard: never sign a quote that isn't the outbound flow we asked for
  if (quote.direction !== "from-rome") {
    throw new Error(`Bridge quote direction "${quote.direction}" != "from-rome"; refusing to sign.`);
  }

  const signed = sdk.userSignedTxs(quote, quote.route); // step-1: the Rome wUSDC burn

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

  // 1. burn wUSDC on Rome (user-signed; no settle, no destination sponsor)
  const burnSigner = p.deps.makeSigner(p.romeRpcUrl);
  const burnHashes: string[] = [];
  for (const item of signed) burnHashes.push(await burnSigner.sendTx(item.tx));
  const burnTxHash = burnHashes[sdk.step1BindingTxIndex(signed)];

  // 2. register (no settle authorization on outbound)
  const record = await sdk.registerTransfer({ quote, step1TxHash: burnTxHash }, opts);

  // 3. poll until the destination claim is ready (Circle attestation) or terminal
  const final = await pollOutbound(sdk, record.id, record, opts, p.deps.sleep, p.pollMax ?? 40, p.pollIntervalMs ?? 3000);

  const q2 = quote.steps.find((s) => isClaimKind(s.kind)) as Record<string, unknown> | undefined;
  const claimStep = (final.steps as Array<{ kind?: string; status?: string }> | undefined)?.find((s) => isClaimKind(s.kind));
  const transmitter = q2?.claimTransmitter as string | undefined;
  const eth = (p.asset ?? "usdc") === "eth";
  const claimHow = eth
    ? `When the Wormhole VAA is ready, redeem it on Ethereum (guard with isTransferCompleted — an already-redeemed VAA reverts with a misleading gas error)`
    : `When Circle attestation is ready, call MessageTransmitterV2.receiveMessage(message, attestation)${transmitter ? ` on ${transmitter}` : ""}`;
  return {
    dryRun: false,
    transferId: record.id,
    route: quote.route,
    outcome: final.outcome,
    flow: sdk.transferFlowStatus(final),
    burnTxHash,
    destinationChainId: p.dest.chainId,
    claim: {
      yourResponsibility: true,
      status: claimStep?.status ?? "pending",
      transmitter,
      domain: q2?.claimDomain as number | undefined,
      note:
        `Claiming on ${p.dest.name} (chain ${p.dest.chainId}) is your step — Rome does not sponsor it. ` +
        `${claimHow} (needs gas on ${p.dest.name}). ` +
        `The bridge-api tracks this transfer at id=${record.id}. See docs/GUIDES.md "Bridge out".`,
    },
  };
}

function claimIsReady(rec: TransferRecord): boolean {
  const step = (rec.steps as Array<{ kind?: string; status?: string }> | undefined)?.find((s) => isClaimKind(s.kind));
  return step?.status === "ready";
}

async function pollOutbound(
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
    if (rec.outcome === "complete" || rec.outcome === "failed" || claimIsReady(rec)) return rec;
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

async function inboundHandler(args: Record<string, string>, intent: InboundIntent, asset: BridgeAsset): Promise<InboundResult> {
  const romeChainId = resolveChainId(args.chain);
  const source = resolveSourceChain(romeChainId, requireArg(args, "from"));
  const amountBaseUnits = assetBaseUnits(asset, requireArg(args, "amount"));
  const base = resolveBridgeBase(romeChainId, args["bridge-api"]);
  const dryRun = args["dry-run"] === "true";
  // Key FIRST (fail fast, no network): derive the actor address for the quote.
  const address = privateKeyToAccount(requireEvmKey()).address;
  return runInboundUsdc({ romeChainId, base, source, amountBaseUnits, address, intent, asset, dryRun, deps: defaultBridgeDeps() });
}

/** `rome fund <chain> --from <source> --amount <usdc>` — USDC → Rome gas (CCTP).
 *  Always USDC: `fund` is the gas on-ramp, and gas is USDC. */
export function fundHandler(args: Record<string, string>): Promise<InboundResult> {
  return inboundHandler(args, "gas", "usdc");
}

/** `rome bridge <chain> --to <dest> --amount <n>` — burn the wrapper on Rome → the asset
 *  on the destination. Rome-side only; claiming on the destination is the user's step. */
async function outboundHandler(args: Record<string, string>, asset: BridgeAsset): Promise<OutboundResult> {
  const romeChainId = resolveChainId(args.chain);
  const dest = resolveSourceChain(romeChainId, requireArg(args, "to"));
  // ETH exits via Wormhole to Ethereum ONLY (the route has no destination knob) —
  // refuse a mismatched --to before any key/network work so funds can't aim wrong.
  if (asset === "eth" && !/^(ethereum|sepolia)$/i.test(dest.name.trim())) {
    throw new Error(`ETH bridges out via Wormhole to Ethereum only — use --to sepolia (got "${dest.name}").`);
  }
  const amountBaseUnits = assetBaseUnits(asset, requireArg(args, "amount"));
  const base = resolveBridgeBase(romeChainId, args["bridge-api"]);
  const dryRun = args["dry-run"] === "true";
  // Key FIRST (fail fast, no network): the burn signer + the actor address.
  const account = privateKeyToAccount(requireEvmKey());
  const facts = getChainFacts(romeChainId);
  const romeRpcUrl = facts.rpcUrl;
  const recipient = (args.recipient as `0x${string}` | undefined) ?? account.address;

  // Outbound needs an activated account (a lamport-funded PDA) for the CCTP burn.
  // Check first with a pure EVM read and point at `rome activate` — otherwise the burn
  // reverts deep in CCTP (Custom(1)). Skip on dry-run (no burn). Inbound needs none.
  if (!dryRun) {
    const pub = createPublicClient({ transport: http(romeRpcUrl) });
    const ethCall = async (to: string, data: `0x${string}`) => {
      const { data: ret } = await pub.call({ to: to as `0x${string}`, data });
      return (ret ?? "0x") as `0x${string}`;
    };
    const status = await readActivation(account.address, facts.romeEvmProgramId, ethCall);
    if (!status.activated) throw notActivatedError(status, args.chain);
  }

  return runOutboundUsdc({ romeChainId, base, romeRpcUrl, dest, amountBaseUnits, address: account.address, recipient, asset, dryRun, deps: defaultBridgeDeps() });
}

/** `rome bridge <chain> --from <src> …` (in: gas|wrapper) OR `--to <dest> …` (out). */
// async so the synchronous asset/direction guards surface as rejections, not throws.
export async function bridgeHandler(args: Record<string, string>): Promise<InboundResult | OutboundResult> {
  const hasFrom = Boolean(args.from);
  const hasTo = Boolean(args.to);
  if (hasFrom && hasTo) throw new Error(`Use --from (bridge in) OR --to (bridge out), not both.`);
  if (!hasFrom && !hasTo) throw new Error(`Bridge direction required: --from <src> (in) or --to <dest> (out).`);
  // Asset guards fire BEFORE any key/network work.
  const asset = (args.asset ?? "usdc").toLowerCase() as BridgeAsset;
  if (asset !== "usdc" && asset !== "eth") {
    throw new Error(`--asset must be "usdc" (default, CCTP) or "eth" (Wormhole) — got "${args.asset}".`);
  }
  if (asset === "eth" && args.intent) {
    throw new Error(`--intent is USDC-only: gas is USDC, so ETH can't bridge in as gas — it lands as wETH. Drop --intent for --asset eth.`);
  }
  if (hasTo) return outboundHandler(args, asset);
  const intent = (args.intent ?? "gas").toLowerCase();
  if (intent !== "gas" && intent !== "wrapper") {
    throw new Error(`--intent must be "gas" or "wrapper" (got "${args.intent}").`);
  }
  return inboundHandler(args, intent as InboundIntent, asset);
}
