import { getChainFacts, getTokenFacts, getContractFacts, getGasFacts, getBalanceFacts, getProgramFacts } from "./facts.js";
import { getCpiRecipe, getPatterns } from "./cookbook.js";
import { callContract, deployContract, sendContract } from "./actions.js";
import { type Deps } from "./deps.js";

export interface ArgSpec {
  name: string;
  required: boolean;
  description: string;
}

/**
 * "read" capabilities are pure lookups — exposed on BOTH the CLI and the MCP server.
 * "action" capabilities write on-chain — they need a signing key and are CLI-ONLY;
 * they are never registered as MCP tools, so a key can never reach the MCP surface.
 */
export type CapabilityKind = "read" | "action";

export interface Capability {
  id: string;
  group: string;
  command: string;
  /** true = invoked as a single verb (`rome deploy`); false = grouped (`rome facts chain`). */
  verb: boolean;
  /** how the CLI invokes it: "facts chain" (grouped) or "deploy" (verb). */
  cliPath: string;
  mcpTool: string;
  summary: string;
  kind: CapabilityKind;
  requiresKey: boolean;
  args: ArgSpec[];
  handler: (args: Record<string, string>, deps?: Deps) => Promise<unknown> | unknown;
}

function mkCap(
  kind: CapabilityKind,
  verb: boolean,
  group: string,
  command: string,
  summary: string,
  args: ArgSpec[],
  handler: Capability["handler"],
): Capability {
  // id stays group.command (stable). CLI + MCP names use single-verb form for verbs.
  // MCP tool names use underscores only (some clients reject hyphens); derivation is
  // deterministic → alignment holds (see alignment.test.ts).
  const cliPath = verb ? command : `${group} ${command}`;
  const mcpTool = (verb ? command : `${group}_${command}`).replace(/-/g, "_");
  return { id: `${group}.${command}`, group, command, verb, cliPath, mcpTool, summary, kind, requiresKey: kind === "action", args, handler };
}

// grouped read (CLI+MCP) / grouped action (CLI-only, key).
const cap = (group: string, command: string, summary: string, args: ArgSpec[], handler: Capability["handler"]) =>
  mkCap("read", false, group, command, summary, args, handler);
// single-verb read / action.
const verbCap = (group: string, command: string, summary: string, args: ArgSpec[], handler: Capability["handler"]) =>
  mkCap("read", true, group, command, summary, args, handler);
const verbAction = (group: string, command: string, summary: string, args: ArgSpec[], handler: Capability["handler"]) =>
  mkCap("action", true, group, command, summary, args, handler);

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

  // ── contract verbs: `call` is a read (CLI+MCP); `deploy`/`send` are CLI-only actions (key) ──
  verbCap(
    "contract",
    "call",
    "Read a contract via eth_call (no key). e.g. rome call hadrian 0x… \"balanceOf(address) returns (uint256)\" 0x…",
    [
      chainArg,
      { name: "address", required: true, description: "contract address (0x…)" },
      { name: "signature", required: true, description: 'function signature, e.g. "balanceOf(address) returns (uint256)"' },
      { name: "args", required: false, description: "comma-separated call args" },
    ],
    (a, deps) => callContract(a.chain, a.address, a.signature, a.args, deps),
  ),
  verbAction(
    "contract",
    "deploy",
    "Deploy a compiled contract (abi+bytecode artifact) to a Rome chain, handling Rome's gas quirks. Needs ROME_EVM_KEY.",
    [
      chainArg,
      { name: "artifact", required: true, description: "path to a compiled artifact JSON (abi + bytecode; Foundry/Hardhat/solc)" },
      { name: "args", required: false, description: "comma-separated constructor args" },
    ],
    (a, deps) => deployContract(a.chain, a.artifact, a.args, deps),
  ),
  verbAction(
    "contract",
    "send",
    "Write to a contract via submitRomeTx (the correct Rome write path). Needs ROME_EVM_KEY.",
    [
      chainArg,
      { name: "address", required: true, description: "contract address (0x…)" },
      { name: "signature", required: true, description: 'function signature, e.g. "deposit(uint256)"' },
      { name: "args", required: false, description: "comma-separated call args" },
    ],
    (a, deps) => sendContract(a.chain, a.address, a.signature, a.args, deps),
  ),
];

export function findCapability(group: string, command: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.group === group && c.command === command);
}

/** Resolve CLI argv to a capability + its remaining positional args. Handles grouped + verb forms. */
export function resolveCli(args: string[]): { cap: Capability; rest: string[] } | undefined {
  const grouped = CAPABILITIES.find((c) => !c.verb && c.group === args[0] && c.command === args[1]);
  if (grouped) return { cap: grouped, rest: args.slice(2) };
  const verb = CAPABILITIES.find((c) => c.verb && c.command === args[0]);
  if (verb) return { cap: verb, rest: args.slice(1) };
  return undefined;
}
