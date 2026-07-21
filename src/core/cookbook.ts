import { PRECOMPILE_ADDRESSES } from "@rome-protocol/sdk";

/**
 * The CPI account-rules agents get wrong, grounded on the SDK's real precompile
 * addresses (not hallucinated), plus which SDK encoder to use.
 */
export function getCpiRecipe(targetProgram?: string) {
  const p = PRECOMPILE_ADDRESSES as Record<string, string>;
  return {
    ...(targetProgram ? { targetProgram } : {}),
    precompiles: { cpi: p.cpi, helper: p.helper, withdraw: p.withdraw, system: p.system },
    accountRules: [
      "The accounts array must be non-empty.",
      "The operator and the program_id must NOT appear in the accounts array.",
      "To sign as your contract, pass HELPER.pda(address(this)) as the signer — the CPI precompile signs as msg.sender (the calling contract's PDA), not tx.origin, so a router cannot sign a user's PDA.",
    ],
    encoders: {
      invoke: "encodeInvoke (from @rome-protocol/sdk)",
      invokeSigned: "encodeInvokeSigned (from @rome-protocol/sdk)",
    },
    note: "Make your Solana instructions authority-agnostic so the signer can be a Solana wallet pubkey or an EVM user's external_auth PDA. Full ABI + per-selector billing: the precompile reference.",
  };
}

export interface Pattern {
  goal: string;
  core: string;
  repo: string;
  also?: string;
  guide: string;
  tags: string[];
}

const PATTERNS: Pattern[] = [
  {
    goal: "AMM / DEX / swap",
    core: "native Solana program + a thin EVM router",
    repo: "rome-dex",
    guide: "developer-guides/call-solana-from-evm",
    tags: ["amm", "dex", "swap", "trade", "liquidity", "pool"],
  },
  {
    goal: "Lending / borrow",
    core: "a Solidity core; Solana users arrive via a synthetic sender",
    repo: "aerarium",
    guide: "developer-guides/dual-lane-app",
    tags: ["lending", "borrow", "supply", "money-market", "compound", "lend"],
  },
  {
    goal: "Call a Solana program from an EVM app (CPI)",
    core: "a thin Solidity wrapper that CPIs your Solana program",
    repo: "cardo",
    guide: "developer-guides/call-solana-from-evm",
    tags: ["cpi", "solana", "jupiter", "meteora", "marinade", "perps", "stake"],
  },
  {
    goal: "From-home — users on another chain",
    core: "on-chain bridge (settle_inbound_bridge) orchestrated by rome-bridge-api",
    repo: "appia",
    also: "rome-bridge-api",
    guide: "developer-guides/from-home",
    tags: ["from-home", "bridge", "cross-chain", "cctp", "wormhole", "home"],
  },
  {
    goal: "Price feeds in a contract",
    core: "Chainlink AggregatorV3Interface over Pyth / Switchboard",
    repo: "rome-oracle-gateway",
    guide: "products/oracle-gateway",
    tags: ["oracle", "price", "feed", "pyth", "switchboard", "chainlink"],
  },
  {
    goal: "Scaffold a new dual-lane app",
    core: "registry + SDK pre-wired, both lanes",
    repo: "create-rome-app",
    guide: "getting-started/ecosystem",
    tags: ["scaffold", "new", "start", "template", "greenfield", "bootstrap"],
  },
];

/** Which example repo + guide fits a build goal. No goal → the full index. */
export function getPatterns(goal?: string): Pattern[] {
  if (!goal) return PATTERNS;
  const q = goal.trim().toLowerCase();
  const hits = PATTERNS.filter(
    (p) => p.goal.toLowerCase().includes(q) || p.tags.some((t) => t.includes(q) || q.includes(t)),
  );
  return hits.length ? hits : PATTERNS;
}

export interface ErrorEntry {
  symptom: string;
  cause: string;
  fix: string;
  tags: string[];
}

// The net-new Rome error taxonomy — the failure modes a builder/agent actually hits,
// each as symptom → cause → fix. Rome-specific behaviours that differ from vanilla EVM.
const ERRORS: ErrorEntry[] = [
  {
    symptom: "eth_estimateGas returns a huge value (often 10-50× the real charge); budgets or hard-fails blow up.",
    cause: "Rome charges the EXACT gas used; the estimate is a loose upper bound, not the amount charged.",
    fix: "Don't hard-fail or size budgets off the estimate. A plain native-token transfer is ~1.48M gas (not 21k) — use a high fixed gas ceiling and let Rome charge exact.",
    tags: ["gas", "estimate", "estimategas", "budget", "21000", "out-of-gas"],
  },
  {
    symptom: "A write or eth_estimateGas fails with Custom(1) attributed to the System Program.",
    cause: "The emulation pool payer is rent-starved — not a fault in your transaction's calldata.",
    fix: "Retry; if it persists the chain's pool payer needs funding (operator side). Your transaction is fine.",
    tags: ["custom(1)", "custom1", "system-program", "pool-payer", "estimate", "rent"],
  },
  {
    symptom: "A transaction fails with Custom(0) and no obvious reason.",
    cause: "An account is TTL-locked (~3-4s) by a concurrent iterative (large) transaction; AccountLocked surfaces as Custom(0).",
    fix: "Retry after a few seconds once the lock clears. Avoid racing the same account from parallel large transactions.",
    tags: ["custom(0)", "custom0", "accountlocked", "locked", "iterative", "concurrency", "retry"],
  },
  {
    symptom: "A transaction that does a CPI fails with CpiProhibitedInIterativeTx.",
    cause: "The transaction was large enough to run in iterative mode, where CPI is prohibited.",
    fix: "Keep CPI transactions small enough to execute atomically (one Solana tx). Split work so the CPI leg stays under the iterative threshold.",
    tags: ["cpi", "iterative", "cpiprohibited", "atomic", "size"],
  },
  {
    symptom: "An on-chain call fails with `Program log: Error: UnknownInstruction(N)` and `custom program error: 0x0`.",
    cause: "The rome-evm program on that chain doesn't implement instruction N — usually a newer feature not yet deployed there.",
    fix: "That chain's rome-evm program needs an upgrade/redeploy to add the instruction. Confirm the feature is deployed on the chain you're calling.",
    tags: ["unknowninstruction", "instruction", "0x0", "program-error", "deploy", "upgrade", "settle"],
  },
  {
    symptom: "`forge script` fails in the simulation step before broadcasting.",
    cause: "Rome's execution model diverges from forge's local EVM simulation.",
    fix: "Run `forge script --skip-simulation`. `cast` and `forge create` work as-is.",
    tags: ["forge", "foundry", "script", "simulation", "skip-simulation", "deploy"],
  },
  {
    symptom: "eth_getLogs returns error -32005 (query range too large).",
    cause: "Rome caps the block range per eth_getLogs query.",
    fix: "Narrow the fromBlock→toBlock window and page the range.",
    tags: ["eth_getlogs", "getlogs", "-32005", "32005", "logs", "range", "query"],
  },
  {
    symptom: "A Solana-lane (Phantom / DoTxUnsigned) action fails with Failure(Custom(1)).",
    cause: "The Solana-lane sender lacks SOL for the on-chain step (the synthetic sender isn't funded with lamports).",
    fix: "Fund the sender's SOL (swap gas to lamports) before the action; submitRomeTxSolanaLane handles the fund leg when wired.",
    tags: ["solana-lane", "custom(1)", "phantom", "sol", "lamports", "sender", "dotxunsigned"],
  },
  {
    symptom: "A Wormhole redeem reverts with 'gas limit too high'.",
    cause: "The VAA was already redeemed.",
    fix: "Guard with isTransferCompleted before redeeming; treat already-redeemed as success.",
    tags: ["wormhole", "vaa", "redeem", "gas-limit-too-high", "already-redeemed", "bridge"],
  },
  {
    symptom: "An inbound `fund --intent gas` completes the CCTP legs but native Rome gas never credits (or ends `settle-failed`).",
    cause: "The final sponsored settle depends on the chain's rome-evm settle instruction; if it's missing/failing the gas conversion can't land.",
    fix: "Read the transfer's degradationReason for the on-chain error; `--intent wrapper` bypasses the settle (delivers wUSDC). The USDC is always safe in the recipient's account.",
    tags: ["bridge", "fund", "settle", "gas", "wrapper", "cctp", "from-home", "degradation"],
  },
];

/** Decode a Rome failure → cause + fix. No query → the full taxonomy. */
export function getErrors(query?: string): ErrorEntry[] {
  if (!query) return ERRORS;
  const q = query.trim().toLowerCase();
  const hits = ERRORS.filter(
    (e) =>
      e.symptom.toLowerCase().includes(q) ||
      e.cause.toLowerCase().includes(q) ||
      e.fix.toLowerCase().includes(q) ||
      e.tags.some((t) => t.includes(q) || q.includes(t)),
  );
  return hits.length ? hits : ERRORS;
}
