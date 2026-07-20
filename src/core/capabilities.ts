import { getChainFacts, getTokenFacts, getContractFacts, getGasFacts, getBalanceFacts, getProgramFacts } from "./facts.js";
import { getCpiRecipe, getPatterns } from "./cookbook.js";
import { type Deps } from "./deps.js";

export interface ArgSpec {
  name: string;
  required: boolean;
  description: string;
}

export interface Capability {
  id: string;
  group: string;
  command: string;
  mcpTool: string;
  summary: string;
  args: ArgSpec[];
  handler: (args: Record<string, string>, deps?: Deps) => Promise<unknown> | unknown;
}

function cap(
  group: string,
  command: string,
  summary: string,
  args: ArgSpec[],
  handler: Capability["handler"],
): Capability {
  // MCP tool names use underscores only (some clients reject hyphens); the CLI keeps the
  // ergonomic hyphen. Derivation stays deterministic → alignment holds (see alignment.test.ts).
  const mcpTool = `${group}_${command}`.replace(/-/g, "_");
  return { id: `${group}.${command}`, group, command, mcpTool, summary, args, handler };
}

const chainArg: ArgSpec = { name: "chain", required: true, description: "chain id, name, or slug (e.g. 200010 or hadrian)" };

/**
 * The single source of truth for BOTH surfaces. The CLI dispatches `rome <group> <command>`
 * to a capability's handler; the MCP server registers each as a tool. Same names, same handlers —
 * alignment is guaranteed by construction, and asserted in test/alignment.test.ts.
 */
export const CAPABILITIES: Capability[] = [
  cap("facts", "chain", "Live chain facts (id, RPC, explorer, program id, gas token) for a Rome chain.", [chainArg], (a) =>
    getChainFacts(a.chain),
  ),
  cap("facts", "tokens", "Token list for a chain (address, mint, symbol, decimals, kind).", [chainArg], (a) =>
    getTokenFacts(a.chain),
  ),
  cap("facts", "contracts", "Deployed contract addresses for a chain.", [chainArg], (a) => getContractFacts(a.chain)),
  cap("facts", "gas", "Current gas price for a chain, with the estimate-vs-charge caveat.", [chainArg], (a, deps) =>
    getGasFacts(a.chain, deps),
  ),
  cap(
    "facts",
    "balance",
    "Native (gas-token) balance for an address on a chain.",
    [chainArg, { name: "address", required: true, description: "0x EVM address" }],
    (a, deps) => getBalanceFacts(a.chain, a.address, deps),
  ),
  cap(
    "facts",
    "programs",
    "Solana program ids for a network (devnet | mainnet).",
    [{ name: "network", required: true, description: "devnet or mainnet" }],
    (a) => getProgramFacts(a.network),
  ),
  cap(
    "cookbook",
    "cpi-recipe",
    "The CPI account-rules + SDK encoders for calling a Solana program from Solidity.",
    [{ name: "program", required: false, description: "optional target Solana program id" }],
    (a) => getCpiRecipe(a.program),
  ),
  cap(
    "cookbook",
    "patterns",
    "Which example repo + guide to use for a build goal.",
    [{ name: "goal", required: false, description: "optional goal keyword (e.g. lending, amm, oracle)" }],
    (a) => getPatterns(a.goal),
  ),
];

export function findCapability(group: string, command: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.group === group && c.command === command);
}
