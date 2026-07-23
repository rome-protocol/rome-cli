import { createPublicClient, http, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAuthorityPda, pubkeyToBytes32, submitRomeTx } from "@rome-protocol/sdk";
import { getContracts } from "@rome-protocol/registry";
import { getChainFacts, resolveChainId } from "./facts.js";
import { requireEvmKey } from "./keys.js";
import { eip1193FromAccount } from "./eip1193.js";

// ── Account activation ──────────────────────────────────────────────────────
// Inbound bridging is frictionless — no per-user account needed. The FIRST time a
// user bridges OUT, CCTP's `deposit_for_burn` creates a per-tx `messageSentEventData`
// account funded by the user's external-auth PDA, which must therefore hold lamports.
// `rome activate` funds that PDA once (via SimpleActivator); `bridge --to` checks it
// and points here if it's missing. The check is a pure EVM read of the PDA's lamports
// through the CpiProgram precompile (`account_lamports`) — no Solana RPC required.

/** SimpleActivator.CCTP_BURN_RESERVE — the lamports one outbound burn's event account needs. */
export const CCTP_BURN_RESERVE = 15_000_000n;

const CPI_PRECOMPILE = "0xff00000000000000000000000000000000000008" as const;
const LAMPORTS_ABI = parseAbi(["function account_lamports(bytes32) view returns (uint64)"]);
const ACTIVATOR_ABI = parseAbi([
  "function activate() payable",
  "function activationCost() view returns (uint256)",
  "function USER_PDA_FUNDING() view returns (uint64)",
  "function topUpUserPda(uint64 lamports) payable",
]);

export interface ActivationStatus {
  address: `0x${string}`;
  pda: string;
  lamports: bigint;
  /** true once the PDA holds enough lamports for at least one outbound CCTP burn. */
  activated: boolean;
}

export type EthCall = (to: string, data: `0x${string}`) => Promise<`0x${string}`>;

/** Read a wallet's activation status as a pure EVM call — the PDA's lamports via `account_lamports`. */
export async function readActivation(address: `0x${string}`, programId: string, ethCall: EthCall): Promise<ActivationStatus> {
  const pdaKey = deriveAuthorityPda(address, programId);
  const data = encodeFunctionData({ abi: LAMPORTS_ABI, functionName: "account_lamports", args: [pubkeyToBytes32(pdaKey)] });
  const ret = await ethCall(CPI_PRECOMPILE, data);
  const lamports = BigInt(ret && ret !== "0x" ? ret : "0x0");
  return { address, pda: pdaKey.toBase58(), lamports, activated: lamports >= CCTP_BURN_RESERVE };
}

/** The clear error `bridge --to` throws when the actor's account isn't activated yet. */
export function notActivatedError(status: ActivationStatus, chain: string | number): Error {
  return new Error(
    `Account not activated for outbound. Your external-auth PDA (${status.pda}) holds ${status.lamports} lamports — ` +
      `outbound needs >= ${CCTP_BURN_RESERVE} to fund CCTP's per-burn event account. ` +
      `Run \`rome activate ${chain}\` first (one-time, ~2 USDC). Inbound (\`--from\`) needs no activation.`,
  );
}

export interface ActivateResult {
  address: `0x${string}`;
  pda: string;
  alreadyActivated: boolean;
  /** true when a drained (activated-but-below-reserve) PDA was refilled via topUpUserPda. */
  toppedUp?: boolean;
  lamports: string;
  txHash?: `0x${string}`;
  cost?: string;
}

export interface ActivateDeps {
  address: `0x${string}`;
  pda: string;
  readLamports(): Promise<bigint>;
  getActivationCost(): Promise<bigint>;
  /** SimpleActivator.USER_PDA_FUNDING — the full lamport level activation establishes. */
  getPdaFunding(): Promise<bigint>;
  activate(cost: bigint): Promise<{ hash: `0x${string}`; success: boolean }>;
  /** SimpleActivator.topUpUserPda(lamports){value} — refill a drained PDA. */
  topUp(lamports: bigint, value: bigint): Promise<{ hash: `0x${string}`; success: boolean }>;
}

/**
 * Three states, one command:
 *  - lamports >= reserve         → already activated; skip (no spend)
 *  - lamports == 0               → never activated; SimpleActivator.activate{value: cost}
 *  - 0 < lamports < reserve      → activated but DRAINED (each burn consumes rent);
 *                                  activate() would revert AlreadyActivated — refill via
 *                                  topUpUserPda back to the full funding level, priced at
 *                                  the on-chain rate (activationCost / USER_PDA_FUNDING).
 */
export async function runActivate(deps: ActivateDeps): Promise<ActivateResult> {
  const before = await deps.readLamports();
  if (before >= CCTP_BURN_RESERVE) {
    return { address: deps.address, pda: deps.pda, alreadyActivated: true, lamports: before.toString() };
  }
  const cost = await deps.getActivationCost();

  if (before > 0n) {
    const funding = await deps.getPdaFunding();
    const lamports = funding - before;
    const value = (lamports * cost + funding - 1n) / funding; // ceil at the on-chain rate
    const { hash, success } = await deps.topUp(lamports, value);
    if (!success) throw new Error(`Top-up tx reverted (${hash}).`);
    const after = await deps.readLamports();
    return { address: deps.address, pda: deps.pda, alreadyActivated: false, toppedUp: true, txHash: hash, cost: value.toString(), lamports: after.toString() };
  }

  const { hash, success } = await deps.activate(cost);
  if (!success) throw new Error(`Activation tx reverted (${hash}).`);
  const after = await deps.readLamports();
  return { address: deps.address, pda: deps.pda, alreadyActivated: false, txHash: hash, cost: cost.toString(), lamports: after.toString() };
}

function resolveActivator(chainId: number): `0x${string}` {
  const raw = getContracts(chainId) as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as { contracts?: unknown[] })?.contracts ?? []) as Array<{
    name?: string;
    address?: string;
    versions?: Array<{ address?: string; status?: string }>;
  }>;
  const entry = list.find((c) => c.name === "SimpleActivator");
  const addr = entry?.versions?.find((v) => v.status === "live")?.address ?? entry?.address;
  if (!addr) throw new Error(`No live SimpleActivator in the registry for chain ${chainId}.`);
  return addr as `0x${string}`;
}

/** Real deps: SimpleActivator from the registry + activate via submitRomeTx. EVM key only. */
export function defaultActivateDeps(chain: string | number): ActivateDeps {
  const c = getChainFacts(chain);
  const account = privateKeyToAccount(requireEvmKey()); // fail fast — no network
  const activator = resolveActivator(c.chainId);
  const pub = createPublicClient({ transport: http(c.rpcUrl) });
  const provider = eip1193FromAccount(account, c.rpcUrl, c.chainId);
  const pdaKey = deriveAuthorityPda(account.address, c.romeEvmProgramId);
  const pdaB32 = pubkeyToBytes32(pdaKey);

  return {
    address: account.address,
    pda: pdaKey.toBase58(),
    async readLamports() {
      const { data } = await pub.call({ to: CPI_PRECOMPILE, data: encodeFunctionData({ abi: LAMPORTS_ABI, functionName: "account_lamports", args: [pdaB32] }) });
      return BigInt(data && data !== "0x" ? data : "0x0");
    },
    async getActivationCost() {
      const { data } = await pub.call({ to: activator, data: encodeFunctionData({ abi: ACTIVATOR_ABI, functionName: "activationCost" }) });
      return BigInt(data && data !== "0x" ? data : "0x0");
    },
    async getPdaFunding() {
      const { data } = await pub.call({ to: activator, data: encodeFunctionData({ abi: ACTIVATOR_ABI, functionName: "USER_PDA_FUNDING" }) });
      return BigInt(data && data !== "0x" ? data : "0x0");
    },
    async activate(cost) {
      const hash = await submitRomeTx(provider, { from: account.address, to: activator, data: encodeFunctionData({ abi: ACTIVATOR_ABI, functionName: "activate" }), value: cost });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      return { hash, success: rcpt.status === "success" };
    },
    async topUp(lamports, value) {
      const data = encodeFunctionData({ abi: ACTIVATOR_ABI, functionName: "topUpUserPda", args: [lamports] });
      const hash = await submitRomeTx(provider, { from: account.address, to: activator, data, value });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      return { hash, success: rcpt.status === "success" };
    },
  };
}

/** `rome activate <chain>` handler — one-time PDA funding for outbound. */
export function activateHandler(args: Record<string, string>): Promise<ActivateResult> {
  resolveChainId(args.chain); // validate the chain up front
  return runActivate(defaultActivateDeps(args.chain));
}
