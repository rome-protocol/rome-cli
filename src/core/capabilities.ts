import { getChainFacts, getTokenFacts, getContractFacts, getGasFacts, getBalanceFacts, getProgramFacts } from "./facts.js";
import { getCpiRecipe, getPatterns, getErrors } from "./cookbook.js";
import { callContract, deployContract, sendContract } from "./actions.js";
import { fundHandler, bridgeHandler } from "./bridge.js";
import { doctor } from "./doctor.js";
import { diagnoseTx } from "./tx.js";
import { verifyHandler } from "./verify.js";
import { activateHandler } from "./activate.js";
import { newHandler } from "./new.js";
import { getPreset } from "./presets.js";
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
  requiresKey?: boolean,
): Capability {
  // id stays group.command (stable). CLI + MCP names use single-verb form for verbs.
  // MCP tool names use underscores only (some clients reject hyphens); derivation is
  // deterministic → alignment holds (see alignment.test.ts).
  // requiresKey defaults by kind; a keyless action (e.g. `new` — writes to disk,
  // signs nothing) overrides it while staying CLI-only.
  const cliPath = verb ? command : `${group} ${command}`;
  const mcpTool = (verb ? command : `${group}_${command}`).replace(/-/g, "_");
  return { id: `${group}.${command}`, group, command, verb, cliPath, mcpTool, summary, kind, requiresKey: requiresKey ?? kind === "action", args, handler };
}

// grouped read (CLI+MCP) / grouped action (CLI-only, key).
const cap = (group: string, command: string, summary: string, args: ArgSpec[], handler: Capability["handler"]) =>
  mkCap("read", false, group, command, summary, args, handler);
// single-verb read / action.
const verbCap = (group: string, command: string, summary: string, args: ArgSpec[], handler: Capability["handler"]) =>
  mkCap("read", true, group, command, summary, args, handler);
const verbAction = (group: string, command: string, summary: string, args: ArgSpec[], handler: Capability["handler"]) =>
  mkCap("action", true, group, command, summary, args, handler);
// keyless action: CLI-only (never MCP) but needs no signing key (e.g. scaffolding).
const verbActionKeyless = (group: string, command: string, summary: string, args: ArgSpec[], handler: Capability["handler"]) =>
  mkCap("action", true, group, command, summary, args, handler, false);

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
    "Solana program ids for a network (devnet | mainnet; Rome testnet chains settle on Solana devnet).",
    [{ name: "network", required: true, description: "devnet or mainnet (testnet settles on the Solana devnet cluster)" }],
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
  cap(
    "cookbook",
    "errors",
    "Decode a Rome failure → cause + fix (the Rome error taxonomy). A query filters; no query returns the full list.",
    [{ name: "query", required: false, description: "optional error text / keyword (e.g. Custom(1), gas, cpi, forge)" }],
    (a) => getErrors(a.query),
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

  // ── doctor: read-only preflight (CLI + MCP) ──
  verbCap(
    "doctor",
    "doctor",
    "Preflight a chain: is it live, is the RPC reachable, is the program configured, is a wallet funded? e.g. rome doctor hadrian --address 0x…",
    [chainArg, { name: "address", required: false, description: "optional 0x address to check is funded" }],
    (a, deps) => doctor(a.chain, a.address, deps),
  ),

  // ── tx: cross-VM diagnosis (read; CLI + MCP) ──
  verbCap(
    "tx",
    "tx",
    "Diagnose a tx: EVM receipt + status, the Solana settlement tx(s) via rome_solanaTxForEvmTx (Rome has no debug_trace*), and a Via link. e.g. rome tx hadrian 0x…",
    [chainArg, { name: "hash", required: true, description: "the EVM tx hash (0x…)" }],
    (a) => diagnoseTx(a.chain, a.hash),
  ),

  // ── preset: ready Rome toolchain config (read; CLI + MCP) ──
  verbCap(
    "preset",
    "preset",
    "Emit a ready Rome network config for your toolchain + the Rome quirks. e.g. rome preset foundry hadrian",
    [{ name: "tool", required: true, description: "foundry or hardhat" }, chainArg],
    (a) => getPreset(a.tool, a.chain),
  ),

  // ── fund / bridge: the "from home" on-ramp (CCTP USDC inbound). CLI-only actions. ──
  verbAction(
    "fund",
    "fund",
    "Fund a wallet: bridge USDC from a source chain into Rome gas (CCTP). Needs ROME_EVM_KEY. e.g. rome fund hadrian --from base-sepolia --amount 1",
    [
      chainArg,
      { name: "from", required: true, description: "source chain (id, name, or slug) holding your USDC" },
      { name: "amount", required: true, description: "USDC amount to bridge (human, e.g. 1.5)" },
      { name: "bridge-api", required: false, description: "override the bridge-api base URL" },
      { name: "dry-run", required: false, description: "quote + plan the source txs without signing/broadcasting" },
    ],
    (a) => fundHandler(a),
  ),
  verbAction(
    "bridge",
    "bridge",
    "Bridge USDC in (--from <src>: gas or wUSDC) or out (--to <dest>: burn wUSDC → USDC on the destination, which you claim there). Needs ROME_EVM_KEY. e.g. rome bridge hadrian --from base-sepolia --amount 1 --intent wrapper · rome bridge hadrian --to base-sepolia --amount 1",
    [
      chainArg,
      { name: "from", required: false, description: "IN: source chain (id/name/slug) holding your USDC" },
      { name: "to", required: false, description: "OUT: destination chain (id/name/slug) to receive USDC — you claim there" },
      { name: "amount", required: true, description: "USDC amount to bridge (human, e.g. 1.5)" },
      { name: "intent", required: false, description: "IN only: gas (default) → native gas · wrapper → wUSDC on Rome" },
      { name: "recipient", required: false, description: "OUT only: destination recipient (default = your address)" },
      { name: "bridge-api", required: false, description: "override the bridge-api base URL" },
      { name: "dry-run", required: false, description: "quote + plan the txs without signing/broadcasting" },
    ],
    (a) => bridgeHandler(a),
  ),

  // ── new: scaffold front door (wraps create-rome-app; keyless, CLI-only) ──
  verbActionKeyless(
    "new",
    "new",
    "Scaffold a dual-lane Rome app (wraps create-rome-app) with the chain pre-wired from the registry, then the lifecycle next-steps: fund → deploy → demo → verify. No key needed. e.g. rome new my-app --chain hadrian",
    [
      { name: "name", required: true, description: "app name (becomes the directory + package name)" },
      { name: "chain", required: false, description: "Rome chain to pre-wire (id, name, or slug; default hadrian)" },
    ],
    (a) => newHandler(a),
  ),

  // ── activate: one-time PDA funding, required before the first bridge OUT ──
  verbAction(
    "activate",
    "activate",
    "One-time account activation for bridging OUT: funds your external-auth PDA so CCTP can create its per-burn event account. Needs ROME_EVM_KEY (~2 USDC; idempotent — skips if already active). Inbound needs no activation. e.g. rome activate hadrian",
    [chainArg],
    (a) => activateHandler(a),
  ),

  // ── verify: the path-aware works-gate (CLI-only action; keys vary by path) ──
  verbAction(
    "verify",
    "verify",
    "The path-aware works-gate. solidity: the SAME contract answers on BOTH lanes (ROME_EVM_KEY + ROME_SOLANA_KEY). solana-program: an EVM-lane call drives a Solana program via CPI (ROME_EVM_KEY). from-home: bridge in → act → bridge out to claim-ready (ROME_EVM_KEY; needs --from + --amount; ~20 min). e.g. rome verify hadrian --path from-home --from sepolia --amount 0.2",
    [
      chainArg,
      { name: "path", required: false, description: "builder path: solidity (default) | solana-program | from-home" },
      { name: "solana-rpc", required: false, description: "solana-program: Solana RPC for the opt-in deep check" },
      { name: "from", required: false, description: "from-home: source chain holding your USDC" },
      { name: "amount", required: false, description: "from-home: USDC amount for the round trip (small, e.g. 0.2)" },
    ],
    (a) => verifyHandler(a),
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
