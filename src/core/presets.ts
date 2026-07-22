import { getChainFacts } from "./facts.js";

// `preset <foundry|hardhat> <chain>` — emit a ready Rome network config for the EVM
// toolchain, plus the Rome quirks. Extend-don't-duplicate: builders keep Foundry/Hardhat;
// this just injects the right RPC/chainId + the caveats. Read-only, sourced from the registry.

export interface PresetResult {
  tool: "foundry" | "hardhat";
  chainId: number;
  filename: string;
  config: string;
  notes: string[];
}

// Rome quirks that hold for every toolchain; tool-specific notes are prepended per tool.
const sharedNotes = (chainId: number): string[] => [
  "Gas: Rome charges the EXACT gas used; `eth_estimateGas` over-predicts (often 10-50×). Don't hard-fail or size budgets off a high estimate — a native transfer is ~1.48M gas, not 21k.",
  "App writes go through `submitRomeTx` (@rome-protocol/sdk) for the correct Rome fee path, not a raw signed tx.",
  `Chain id: ${chainId}.`,
];

const foundryNotes = (chainId: number): string[] => [
  "Deploy scripts: run `forge script --skip-simulation` — Rome's execution diverges from forge's local simulation. `forge create` and `cast` work as-is.",
  ...sharedNotes(chainId),
];

export function getPreset(tool: string, chain: string | number): PresetResult {
  const t = tool.trim().toLowerCase();
  const c = getChainFacts(chain);
  const slug = c.name.toLowerCase().split(/\s+/).pop() ?? String(c.chainId); // "hadrian"
  const camel = `rome${slug.charAt(0).toUpperCase()}${slug.slice(1)}`; // "romeHadrian"

  if (t === "foundry") {
    return {
      tool: "foundry",
      chainId: c.chainId,
      filename: "foundry.toml",
      config: `[rpc_endpoints]\nrome-${slug} = "${c.rpcUrl}"\n\n# deploy: forge create --rpc-url rome-${slug} ...   (scripts: add --skip-simulation)`,
      notes: foundryNotes(c.chainId),
    };
  }
  if (t === "hardhat") {
    return {
      tool: "hardhat",
      chainId: c.chainId,
      filename: "hardhat.config.ts",
      config: `networks: {\n  ${camel}: {\n    url: "${c.rpcUrl}",\n    chainId: ${c.chainId},\n  },\n}`,
      notes: sharedNotes(c.chainId),
    };
  }
  throw new Error(`Unknown preset tool "${tool}". Supported: foundry, hardhat.`);
}
