import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbiItem,
  type AbiFunction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { submitRomeTx } from "@rome-protocol/sdk";
import { getChainFacts } from "./facts.js";
import { requireEvmKey } from "./keys.js";
import { eip1193FromAccount } from "./eip1193.js";
import { defaultDeps, type Deps } from "./deps.js";

/** JSON can't serialize BigInt — stringify them (viem returns BigInt for uint outputs). */
function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

/** Parse a human function signature ("balanceOf(address) view returns (uint256)") to an AbiFunction. */
export function parseFn(signature: string): AbiFunction {
  const src = signature.trim().startsWith("function") ? signature.trim() : `function ${signature.trim()}`;
  const item = parseAbiItem(src) as AbiFunction;
  if (item.type !== "function") throw new Error(`Not a function signature: "${signature}"`);
  return item;
}

/** Coerce comma-separated string args to viem-typed values per the ABI input types. */
export function coerceArgs(inputs: readonly { type: string }[], raw?: string): unknown[] {
  if (!raw) return [];
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.map((v, i) => {
    const t = inputs[i]?.type ?? "";
    if (/^u?int\d*$/.test(t)) return BigInt(v);
    if (t === "bool") return v === "true";
    return v; // address / bytes / string pass through
  });
}

function loadArtifact(path: string): { abi: unknown[]; bytecode: `0x${string}` } {
  const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const abi = j.abi as unknown[] | undefined;
  let bc: unknown = j.bytecode ?? (j.evm as Record<string, unknown> | undefined)?.bytecode;
  if (bc && typeof bc === "object") bc = (bc as Record<string, unknown>).object; // Foundry/solc {bytecode:{object}}
  if (!abi || typeof bc !== "string" || bc.length < 2) {
    throw new Error(`Artifact must contain { abi, bytecode }: ${path}`);
  }
  const bytecode = (bc.startsWith("0x") ? bc : `0x${bc}`) as `0x${string}`;
  return { abi, bytecode };
}

/** Read a contract via eth_call. No key. */
export async function callContract(
  chain: string | number,
  address: string,
  signature: string,
  argsCsv: string | undefined,
  _deps: Deps = defaultDeps,
) {
  const c = getChainFacts(chain);
  const fn = parseFn(signature);
  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: coerceArgs(fn.inputs, argsCsv) });
  const pub = createPublicClient({ transport: http(c.rpcUrl) });
  const { data: ret } = await pub.call({ to: address as `0x${string}`, data });
  const decoded =
    fn.outputs.length && ret && ret !== "0x" ? decodeFunctionResult({ abi: [fn], functionName: fn.name, data: ret }) : ret ?? "0x";
  return { chainId: c.chainId, address, function: fn.name, result: jsonSafe(decoded) };
}

/** Deploy a compiled contract (artifact = {abi, bytecode}) with Rome's gas quirks. Needs a key. */
export async function deployContract(
  chain: string | number,
  artifactPath: string,
  argsCsv: string | undefined,
  _deps: Deps = defaultDeps,
) {
  const c = getChainFacts(chain);
  const key = requireEvmKey();
  const { abi, bytecode } = loadArtifact(artifactPath);
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, transport: http(c.rpcUrl) });
  const pub = createPublicClient({ transport: http(c.rpcUrl) });
  const gp = await pub.getGasPrice();
  const ctor = (abi as AbiFunction[]).find((x) => (x as { type?: string }).type === "constructor");
  // High fixed gas ceiling: Rome charges exact, so an over-provisioned limit is safe (create-rome-app pattern).
  const hash = await wallet.deployContract({
    abi: abi as never,
    bytecode,
    args: coerceArgs(ctor?.inputs ?? [], argsCsv) as never,
    chain: null,
    gas: 26_000_000n,
    maxFeePerGas: (gp * 3n) / 2n,
    maxPriorityFeePerGas: 0n,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  return { chainId: c.chainId, deployer: account.address, txHash: hash, address: rcpt.contractAddress, status: rcpt.status };
}

/** Write to a contract via submitRomeTx (the correct Rome write path). Needs a key. */
export async function sendContract(
  chain: string | number,
  address: string,
  signature: string,
  argsCsv: string | undefined,
  _deps: Deps = defaultDeps,
) {
  const c = getChainFacts(chain);
  const key = requireEvmKey();
  const fn = parseFn(signature);
  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: coerceArgs(fn.inputs, argsCsv) });
  const account = privateKeyToAccount(key);
  const provider = eip1193FromAccount(account, c.rpcUrl, c.chainId);
  const hash = await submitRomeTx(provider, { from: account.address, to: address, data });
  return { chainId: c.chainId, from: account.address, to: address, function: fn.name, txHash: hash };
}
