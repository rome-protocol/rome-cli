import { listChains, getChain, getTokens, getContracts, getPrograms } from "@rome-protocol/registry";
import { defaultDeps, type Deps } from "./deps.js";

const GAS_NOTE =
  "eth_estimateGas can over-predict by a large factor; Rome charges the exact gas used, so don't hard-fail or size budgets off a high estimate. A plain native-token transfer costs ~1.48M gas (not 21k).";

function knownList(): string {
  return listChains()
    .map((c) => `${c.chainId} (${c.name})`)
    .join(", ");
}

/**
 * Resolve a chain id, name, or slug to a numeric chainId — by EXACT match against a
 * chain's id, full name ("Rome Hadrian"), short name ("hadrian"), or slug
 * ("200010-hadrian"). Exact-only + order-independent: a shared prefix like "Rome" or a
 * numeric superstring like "2000109" resolves to nothing and throws, rather than silently
 * returning the wrong chain.
 */
export function resolveChainId(input: string | number): number {
  const asNum = typeof input === "number" ? input : Number(String(input).trim());
  if (Number.isInteger(asNum) && getChain(asNum)) return asNum;

  const q = String(input).trim().toLowerCase();
  if (!q) throw new Error(`Empty chain input. Known chains: ${knownList()}`);

  const matches = new Set<number>();
  for (const c of listChains()) {
    const shortName = c.name.toLowerCase().split(/\s+/).pop() ?? "";
    const candidates = new Set<string>([
      String(c.chainId),
      c.name.toLowerCase(), // "rome hadrian"
      shortName, // "hadrian"
      `${c.chainId}-${shortName}`, // "200010-hadrian"
    ]);
    if (candidates.has(q)) matches.add(c.chainId);
  }
  if (matches.size === 1) return [...matches][0];
  if (matches.size > 1) {
    throw new Error(`Ambiguous chain "${input}" (matches ${[...matches].join(", ")}). Use the chain id.`);
  }
  throw new Error(`Unknown chain "${input}". Known chains: ${knownList()}`);
}

export function getChainFacts(input: string | number) {
  const chain = getChain(resolveChainId(input));
  // resolveChainId guarantees the chain exists.
  return chain as NonNullable<typeof chain> & {
    rpcUrl: string;
    romeEvmProgramId: string;
    nativeCurrency: { symbol: string; decimals: number };
  };
}

export function getTokenFacts(input: string | number) {
  const chainId = resolveChainId(input);
  return {
    chainId,
    tokens: getTokens(chainId) ?? [],
    note: "Token entries omit assetRef — match a wrapper to its underlying by shared mint (mintId); the gas token's wrapper shares its mint.",
  };
}

export function getContractFacts(input: string | number) {
  const chainId = resolveChainId(input);
  return { chainId, contracts: getContracts(chainId) ?? {} };
}

const KNOWN_NETWORKS = ["devnet", "testnet", "mainnet"];

export function getProgramFacts(network: string) {
  const n = String(network).trim().toLowerCase();
  if (!KNOWN_NETWORKS.includes(n)) {
    throw new Error(`Unknown network "${network}". Known networks: ${KNOWN_NETWORKS.join(", ")}.`);
  }
  return { network: n, programs: getPrograms(n) };
}

export async function getGasFacts(input: string | number, deps: Deps = defaultDeps) {
  const chain = getChainFacts(input);
  const price = await deps.makeRpc(chain.rpcUrl).getGasPrice();
  return { chainId: chain.chainId, gasPriceWei: price.toString(), note: GAS_NOTE };
}

export async function getBalanceFacts(input: string | number, address: string, deps: Deps = defaultDeps) {
  const chain = getChainFacts(input);
  const bal = await deps.makeRpc(chain.rpcUrl).getBalance(address);
  return {
    chainId: chain.chainId,
    address,
    balanceWei: bal.toString(),
    note: `Raw native balance in wei; the gas token is ${chain.nativeCurrency.symbol}.`,
  };
}
