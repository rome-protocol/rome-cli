import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChainFacts } from "./facts.js";

// `rome new <app-name> [--chain <chain>]` — the scaffold front door. WRAPS
// create-rome-app (the scaffolder stays canonical — we never rebuild it), then adds
// the Rome-unique glue: resolve the chain through the registry, pre-wire it into the
// app's .env, and hand back the lifecycle next-steps (fund → deploy → demo → verify).
// CLI-only (the MCP surface never writes to disk) but KEYLESS — it signs nothing.

const SCAFFOLDER = "github:rome-protocol/create-rome-app"; // floats on main; pin when it tags

export interface NewDeps {
  targetExists(appName: string): boolean;
  /** Run the canonical scaffolder (npx create-rome-app <app-name>). */
  scaffold(appName: string): Promise<void>;
  /** Write <app>/.env from .env.example with CHAIN_ID pre-wired. */
  writeChainEnv(appName: string, chainId: number): Promise<void>;
}

export interface NewResult {
  app: string;
  chainId: number;
  chainName: string;
  next: string[];
}

/** .env.example → .env content with CHAIN_ID set (uncommented; appended if absent). */
export function projectChainEnv(exampleContent: string, chainId: number): string {
  const line = `CHAIN_ID=${chainId}`;
  if (/^#?\s*CHAIN_ID=.*$/m.test(exampleContent)) {
    return exampleContent.replace(/^#?\s*CHAIN_ID=.*$/m, line);
  }
  return exampleContent.replace(/\n*$/, "\n") + line + "\n";
}

/** Validate → scaffold (canonical) → pre-wire the chain → grounded next steps. */
export async function runNew(appName: string, chain: string | number | undefined, deps: NewDeps): Promise<NewResult> {
  if (!appName || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(appName)) {
    throw new Error(`Invalid app name "${appName}" — use letters/digits/dashes (it becomes a directory + package name).`);
  }
  const c = getChainFacts(chain ?? "hadrian"); // throws "Unknown chain …" BEFORE any npx spend
  if (deps.targetExists(appName)) {
    throw new Error(`"${appName}" already exists here — pick another name or remove it first.`);
  }

  await deps.scaffold(appName);
  await deps.writeChainEnv(appName, c.chainId);

  const slug = String(chain ?? "hadrian");
  return {
    app: appName,
    chainId: c.chainId,
    chainName: c.name,
    next: [
      `cd ${appName} && npm install`,
      `# fund the wallets in .env (gas is USDC — bridge it in; no faucet):`,
      `rome fund ${slug} --from base-sepolia --amount 1`,
      `npm run deploy      # deploy the Vault to ${c.name}`,
      `npm run demo        # the funded dual-lane proof (MetaMask + Phantom → one Vault)`,
      `rome verify ${slug}   # the works-gate, any path`,
    ],
  };
}

const pExecFile = promisify(execFile);

/** Real deps: npx the canonical scaffolder + fs env projection. */
export function defaultNewDeps(): NewDeps {
  return {
    targetExists: (appName) => existsSync(join(process.cwd(), appName)),
    async scaffold(appName) {
      try {
        await pExecFile("npx", ["-y", SCAFFOLDER, appName], { cwd: process.cwd(), timeout: 300_000 });
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        throw new Error(`create-rome-app failed: ${(err.stderr || err.message || "").trim().slice(0, 400)}`);
      }
    },
    async writeChainEnv(appName, chainId) {
      const dir = join(process.cwd(), appName);
      const example = join(dir, ".env.example");
      const content = existsSync(example) ? readFileSync(example, "utf8") : "";
      writeFileSync(join(dir, ".env"), projectChainEnv(content, chainId));
    },
  };
}

/** `rome new <app-name> [--chain <chain>]` handler — keyless; CLI-only. */
export async function newHandler(args: Record<string, string>): Promise<NewResult> {
  if (!args.name) throw new Error("Missing app name. Usage: rome new <app-name> [--chain <chain>]");
  return runNew(args.name, args.chain, defaultNewDeps());
}
