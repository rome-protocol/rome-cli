import { createPublicClient, createWalletClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, type Transaction } from "@solana/web3.js";
import { submitRomeTx, submitRomeTxSolanaLane } from "@rome-protocol/sdk";
import { getChainFacts } from "./facts.js";
import { requireEvmKey, requireSolanaKey } from "./keys.js";
import { eip1193FromAccount } from "./eip1193.js";
import { STORE_PROBE } from "./probe.js";

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

/** `rome verify --path solidity` handler — validates the path, then runs the gate. */
export async function verifyHandler(args: Record<string, string>): Promise<VerifyResult> {
  const path = (args.path ?? "solidity").toLowerCase();
  if (path !== "solidity") {
    throw new Error(`Only --path solidity is supported in this slice (got "${path}"). solana-program + from-home follow.`);
  }
  // async so a synchronous key/config throw surfaces as a rejected promise, not a throw.
  return runVerifySolidity(defaultVerifyDeps(args.chain));
}
