import { createPublicClient, createWalletClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, type Transaction } from "@solana/web3.js";
import { submitRomeTx, submitRomeTxSolanaLane } from "@rome-protocol/sdk";
import { getTokens } from "@rome-protocol/registry";
import { getChainFacts } from "./facts.js";
import { requireEvmKey, requireSolanaKey } from "./keys.js";
import { eip1193FromAccount } from "./eip1193.js";
import { STORE_PROBE, CPI_MEMO_PROBE } from "./probe.js";
import { runInboundUsdc, runOutboundUsdc, resolveSourceChain, resolveBridgeBase, usdcBaseUnits, defaultBridgeDeps } from "./bridge.js";
import { readActivation, notActivatedError } from "./activate.js";

// `rome verify --path solidity` — the both-lane works-gate. Deploy a probe, then prove
// the SAME contract answers when set from the EVM lane (submitRomeTx) AND the Solana lane
// (submitRomeTxSolanaLane). A funded ACTION (needs an EVM key + a Solana key); CLI-only,
// never MCP. The lane ops are injectable so the orchestration is unit-testable.

export interface VerifyCheck {
  lane: "evm" | "solana";
  wrote: string;
  read: string;
  ok: boolean;
}
export interface VerifyResult {
  path: "solidity";
  probe: string;
  checks: VerifyCheck[];
  ok: boolean;
}

export interface VerifyDeps {
  deployProbe(): Promise<`0x${string}`>;
  evmLaneSet(probe: `0x${string}`, value: bigint): Promise<void>;
  solanaLaneSet(probe: `0x${string}`, value: bigint): Promise<void>;
  read(probe: `0x${string}`): Promise<bigint>;
}

const EVM_VALUE = 42n;
const SOLANA_VALUE = 43n;

/** Deploy a probe, then prove the SAME contract answers when set from each lane. */
export async function runVerifySolidity(deps: VerifyDeps): Promise<VerifyResult> {
  const probe = await deps.deployProbe();
  const checks: VerifyCheck[] = [];

  await deps.evmLaneSet(probe, EVM_VALUE);
  const r1 = await deps.read(probe);
  checks.push({ lane: "evm", wrote: EVM_VALUE.toString(), read: r1.toString(), ok: r1 === EVM_VALUE });

  await deps.solanaLaneSet(probe, SOLANA_VALUE);
  const r2 = await deps.read(probe);
  checks.push({ lane: "solana", wrote: SOLANA_VALUE.toString(), read: r2.toString(), ok: r2 === SOLANA_VALUE });

  return { path: "solidity", probe, checks, ok: checks.every((c) => c.ok) };
}

/** Real lane ops: viem deploy + submitRomeTx (EVM lane) + submitRomeTxSolanaLane (Solana lane). */
export function defaultVerifyDeps(chain: string | number): VerifyDeps {
  const c = getChainFacts(chain);
  const account = privateKeyToAccount(requireEvmKey()); // fail fast — no network
  const solKeypair = requireSolanaKey(); // fail fast
  const pub = createPublicClient({ transport: http(c.rpcUrl) });
  const provider = eip1193FromAccount(account, c.rpcUrl, c.chainId);
  const solanaRpc = (c as { solana?: { rpc?: string } }).solana?.rpc ?? "https://api.devnet.solana.com";
  const connection = new Connection(solanaRpc, "confirmed");
  const setData = (value: bigint) => encodeFunctionData({ abi: STORE_PROBE.abi, functionName: "set", args: [value] });

  return {
    async deployProbe() {
      const wallet = createWalletClient({ account, transport: http(c.rpcUrl) });
      const gp = await pub.getGasPrice();
      const hash = await wallet.deployContract({
        abi: STORE_PROBE.abi as never,
        bytecode: STORE_PROBE.bytecode,
        chain: null,
        gas: 26_000_000n,
        maxFeePerGas: (gp * 3n) / 2n,
        maxPriorityFeePerGas: 0n,
      });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      if (!rcpt.contractAddress) throw new Error("probe deploy produced no contract address");
      return rcpt.contractAddress;
    },
    async evmLaneSet(probe, value) {
      const hash = await submitRomeTx(provider, { from: account.address, to: probe, data: setData(value) });
      await pub.waitForTransactionReceipt({ hash });
    },
    async solanaLaneSet(probe, value) {
      await submitRomeTxSolanaLane(
        {
          connection,
          proxyUrl: c.rpcUrl,
          programId: c.romeEvmProgramId,
          chainId: c.chainId,
          payer: solKeypair.publicKey,
          signTransaction: async (tx: Transaction) => {
            tx.partialSign(solKeypair);
            return tx;
          },
        },
        { to: probe, data: setData(value), autoProvision: true },
      );
    },
    async read(probe) {
      const data = encodeFunctionData({ abi: STORE_PROBE.abi, functionName: "get" });
      const { data: ret } = await pub.call({ to: probe, data });
      return BigInt(ret ?? "0x0");
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// `rome verify --path solana-program` — the cross-VM works-gate. Deploy a thin CPI
// wrapper (its constructor self-provisions the contract's external-auth PDA), then an
// EVM-lane `ping` drives the SPL Memo program via the CPI precompile (0xff..08). A
// successful EVM receipt IS the proof — a failed CPI reverts the tx. EVM-lane ONLY
// (ROME_EVM_KEY; no Solana key). The Solana-log confirmation is an opt-in deep check,
// gated on a Solana RPC (`--solana-rpc`), since the public CLI's default Solana RPC is
// substituted to public devnet and the core gate needs no RPC at all.

export interface VerifySolanaProgramResult {
  path: "solana-program";
  probe: `0x${string}`;
  program: string;
  memo: string;
  evmTx: `0x${string}`;
  cpiLanded: boolean;
  solanaSettlement?: string;
  memoConfirmed?: boolean;
  ok: boolean;
}

export interface VerifySolanaProgramDeps {
  deployProbe(): Promise<`0x${string}`>;
  ping(probe: `0x${string}`, memo: string): Promise<{ hash: `0x${string}`; success: boolean }>;
  /** Opt-in deep check: confirm the memo landed in the Solana settlement logs. */
  confirmMemo?(evmTxHash: `0x${string}`, memo: string): Promise<{ settlement?: string; found: boolean }>;
}

/** Deploy the CPI wrapper, drive it from the EVM lane, and (optionally) confirm the effect. */
export async function runVerifySolanaProgram(deps: VerifySolanaProgramDeps): Promise<VerifySolanaProgramResult> {
  const probe = await deps.deployProbe();
  const memo = `rome-verify:${probe}`;
  const { hash, success } = await deps.ping(probe, memo);

  let solanaSettlement: string | undefined;
  let memoConfirmed: boolean | undefined;
  if (deps.confirmMemo) {
    const c = await deps.confirmMemo(hash, memo);
    solanaSettlement = c.settlement;
    memoConfirmed = c.found;
  }
  // Core gate = the EVM tx landed (a failed CPI reverts it). When the deep check runs,
  // it must also find the memo we sent in the Solana settlement logs.
  const ok = success && (memoConfirmed ?? true);
  return { path: "solana-program", probe, program: CPI_MEMO_PROBE.memoProgram, memo, evmTx: hash, cpiLanded: success, solanaSettlement, memoConfirmed, ok };
}

/** Real deps: viem deploy of the CPI probe + `ping` via submitRomeTx. EVM key ONLY. */
export function defaultVerifySolanaProgramDeps(chain: string | number, opts?: { solanaRpc?: string }): VerifySolanaProgramDeps {
  const c = getChainFacts(chain);
  const account = privateKeyToAccount(requireEvmKey()); // fail fast — no network, no Solana key required
  const pub = createPublicClient({ transport: http(c.rpcUrl) });
  const provider = eip1193FromAccount(account, c.rpcUrl, c.chainId);

  return {
    async deployProbe() {
      const wallet = createWalletClient({ account, transport: http(c.rpcUrl) });
      const gp = await pub.getGasPrice();
      const hash = await wallet.deployContract({
        abi: CPI_MEMO_PROBE.abi as never,
        bytecode: CPI_MEMO_PROBE.bytecode,
        chain: null,
        gas: 26_000_000n,
        maxFeePerGas: (gp * 3n) / 2n,
        maxPriorityFeePerGas: 0n,
      });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      if (!rcpt.contractAddress) throw new Error("CPI probe deploy produced no contract address");
      return rcpt.contractAddress;
    },
    async ping(probe, memo) {
      const data = encodeFunctionData({ abi: CPI_MEMO_PROBE.abi, functionName: "ping", args: [memo] });
      const hash = await submitRomeTx(provider, { from: account.address, to: probe, data });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      return { hash, success: rcpt.status === "success" };
    },
    confirmMemo: opts?.solanaRpc
      ? async (evmTxHash, memo) => {
          const res = await fetch(c.rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rome_solanaTxForEvmTx", params: [evmTxHash] }),
          });
          const sigs: string[] = ((await res.json()) as { result?: string[] })?.result ?? [];
          const connection = new Connection(opts.solanaRpc!, "confirmed");
          for (const sig of sigs) {
            const stx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
            if ((stx?.meta?.logMessages ?? []).some((l) => l.includes(memo))) return { settlement: sig, found: true };
          }
          return { settlement: sigs[0], found: false };
        }
      : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// `rome verify --path from-home` — the round-trip works-gate. Bridge USDC IN as
// wUSDC (CCTP wrapper intent) → ACT with it on Rome (a real wUSDC self-transfer via
// submitRomeTx) → bridge it back OUT to attestation-ready + a claim handle. Legs run
// in order and fail fast. The gate asserts to attestation-ready — the destination
// claim is the user's own step (Rome sponsors inbound settle, never the outbound
// claim). Prereqs checked up front: activation (the out-leg burns), source USDC +
// gas, Rome gas. EVM key only. The in-leg waits on Circle attestation (~15–20 min).

export interface VerifyFromHomeResult {
  path: "from-home";
  legs: {
    in: { ok: boolean; txHash?: string; landed?: boolean; wusdcDelta?: string };
    act?: { ok: boolean; hash?: string };
    out?: { ok: boolean; burnTxHash?: string; claimReady?: boolean };
  };
  ok: boolean;
}

export interface VerifyFromHomeDeps {
  /** Bridge USDC in (wrapper intent); resolve once the transfer completes and report the wUSDC delta. */
  bridgeIn(): Promise<{ txHash: string; landed: boolean; wusdcDelta: bigint }>;
  /** One real act with the bridged asset on Rome (wUSDC self-transfer). */
  act(amount: bigint): Promise<{ hash: `0x${string}`; success: boolean }>;
  /** Bridge back out; ready = burn landed + Circle attestation ready (claim handle emitted). */
  bridgeOut(amount: bigint): Promise<{ burnTxHash: string; claimReady: boolean }>;
}

/** In → act → out, failing fast — a red leg stops the gate. */
export async function runVerifyFromHome(deps: VerifyFromHomeDeps): Promise<VerifyFromHomeResult> {
  const inRes = await deps.bridgeIn();
  const inOk = inRes.landed && inRes.wusdcDelta > 0n;
  const legs: VerifyFromHomeResult["legs"] = {
    in: { ok: inOk, txHash: inRes.txHash, landed: inRes.landed, wusdcDelta: inRes.wusdcDelta.toString() },
  };
  if (!inOk) return { path: "from-home", legs, ok: false };

  const actRes = await deps.act(inRes.wusdcDelta);
  legs.act = { ok: actRes.success, hash: actRes.hash };
  if (!actRes.success) return { path: "from-home", legs, ok: false };

  const outRes = await deps.bridgeOut(inRes.wusdcDelta);
  legs.out = { ok: outRes.claimReady, burnTxHash: outRes.burnTxHash, claimReady: outRes.claimReady };
  return { path: "from-home", legs, ok: legs.out.ok };
}

const ERC20_ABI = [
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "owner", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

/** The chain's wUSDC wrapper — the spl_wrapper over the gas token's mint (registry getTokens drops assetRef). */
export function wrapperUsdcAddress(chainId: number): `0x${string}` {
  const raw = getTokens(chainId) as unknown;
  const rows = (Array.isArray(raw) ? raw : (raw as { tokens?: unknown[] })?.tokens ?? []) as Array<{ address?: string; kind?: string; mintId?: string }>;
  const gas = rows.find((t) => t.kind === "gas");
  const w = gas && rows.find((t) => t.kind === "spl_wrapper" && t.mintId === gas.mintId);
  if (!w?.address) throw new Error(`No wUSDC wrapper (spl_wrapper over the gas mint) in the registry for chain ${chainId}.`);
  return w.address as `0x${string}`;
}

/** Real legs: the bridge engines + a wUSDC self-transfer. EVM key only. */
export function defaultVerifyFromHomeDeps(
  chain: string | number,
  opts: { from: string; amount: string; bridgeApi?: string },
): VerifyFromHomeDeps {
  const c = getChainFacts(chain);
  const account = privateKeyToAccount(requireEvmKey()); // fail fast — no network
  const source = resolveSourceChain(c.chainId, opts.from);
  const base = resolveBridgeBase(c.chainId, opts.bridgeApi);
  const amountBaseUnits = usdcBaseUnits(opts.amount);
  const wusdc = wrapperUsdcAddress(c.chainId);
  const pub = createPublicClient({ transport: http(c.rpcUrl) });
  const provider = eip1193FromAccount(account, c.rpcUrl, c.chainId);
  const balance = async () =>
    BigInt((await pub.readContract({ address: wusdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint);

  return {
    async bridgeIn() {
      const before = await balance();
      // Wrapper intent; wait through Circle attestation (~15–20 min) to completion.
      const r = await runInboundUsdc({
        romeChainId: c.chainId,
        base,
        source,
        amountBaseUnits,
        address: account.address,
        intent: "wrapper",
        pollMax: 400,
        pollIntervalMs: 5000,
        deps: defaultBridgeDeps(),
      });
      if (r.dryRun) throw new Error("unexpected dry-run result in the from-home in-leg");
      const landed = r.outcome === "complete";
      const after = landed ? await balance() : before;
      return { txHash: r.step1TxHash, landed, wusdcDelta: after - before };
    },
    async act(amount) {
      const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [account.address, amount] });
      const hash = await submitRomeTx(provider, { from: account.address, to: wusdc, data });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      return { hash, success: rcpt.status === "success" };
    },
    async bridgeOut(amount) {
      const r = await runOutboundUsdc({
        romeChainId: c.chainId,
        base,
        romeRpcUrl: c.rpcUrl,
        dest: source, // round trip: back to the chain the funds came from
        amountBaseUnits: amount,
        address: account.address,
        recipient: account.address,
        deps: defaultBridgeDeps(),
      });
      if (r.dryRun) throw new Error("unexpected dry-run result in the from-home out-leg");
      return { burnTxHash: r.burnTxHash, claimReady: r.claim.status === "ready" };
    },
  };
}

/** `rome verify --path <solidity|solana-program|from-home>` handler. */
export async function verifyHandler(
  args: Record<string, string>,
): Promise<VerifyResult | VerifySolanaProgramResult | VerifyFromHomeResult> {
  const path = (args.path ?? "solidity").toLowerCase();
  // async so a synchronous key/config throw surfaces as a rejected promise, not a throw.
  if (path === "solidity") return runVerifySolidity(defaultVerifyDeps(args.chain));
  if (path === "solana-program") return runVerifySolanaProgram(defaultVerifySolanaProgramDeps(args.chain, { solanaRpc: args["solana-rpc"] }));
  if (path === "from-home") {
    if (!args.from) throw new Error("from-home needs --from <source chain> (where your USDC starts).");
    if (!args.amount) throw new Error("from-home needs --amount <usdc> (small, e.g. 0.2).");
    const c = getChainFacts(args.chain);
    const account = privateKeyToAccount(requireEvmKey());
    // The out-leg burns — check activation FIRST so we never bridge in and then strand.
    const pub = createPublicClient({ transport: http(c.rpcUrl) });
    const ethCall = async (to: string, data: `0x${string}`) => {
      const { data: ret } = await pub.call({ to: to as `0x${string}`, data });
      return (ret ?? "0x") as `0x${string}`;
    };
    const status = await readActivation(account.address, c.romeEvmProgramId, ethCall);
    if (!status.activated) throw notActivatedError(status, args.chain);
    return runVerifyFromHome(defaultVerifyFromHomeDeps(args.chain, { from: args.from, amount: args.amount, bridgeApi: args["bridge-api"] }));
  }
  throw new Error(`--path ${path} is not supported (available: solidity, solana-program, from-home).`);
}
