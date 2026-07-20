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
