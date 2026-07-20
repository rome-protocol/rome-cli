import { CAPABILITIES, resolveCli } from "./core/capabilities.js";
import { defaultDeps } from "./core/deps.js";

const VERSION = "0.1.0";

/** Every CLI invocation path the CLI dispatches ("facts chain", "deploy", …). */
export function cliCommandTable(): string[] {
  return CAPABILITIES.map((c) => c.cliPath);
}

function helpText(): string {
  const lines = [
    "rome — Rome Protocol dev CLI + MCP server",
    "",
    "Usage: rome <command> [args]        (e.g. rome facts chain hadrian · rome deploy …)",
    "       rome mcp                     start the MCP server (stdio, read-only)",
    "",
    "Commands:",
  ];
  for (const c of CAPABILITIES) {
    const a = c.args.map((x) => (x.required ? `<${x.name}>` : `[${x.name}]`)).join(" ");
    const tag = c.kind === "action" ? "  [needs ROME_EVM_KEY]" : "";
    lines.push(`  rome ${c.cliPath}${a ? " " + a : ""}${tag}\n      ${c.summary}`);
  }
  return lines.join("\n");
}

export async function main(argv: string[]): Promise<number | void> {
  const args = argv.slice(2);
  const first = args[0];

  if (!first || first === "help" || first === "--help" || first === "-h") {
    console.log(helpText());
    return 0;
  }
  if (first === "--version" || first === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (first === "mcp") {
    const { startMcpServer } = await import("./mcp.js");
    await startMcpServer();
    // Return void: the stdio transport keeps the process alive on open stdin.
    // bin.ts must NOT process.exit() here, or it kills the server the moment it's ready.
    return;
  }

  const resolved = resolveCli(args);
  if (!resolved) {
    console.error(`Unknown command: rome ${args.slice(0, 2).join(" ")}`);
    console.error("\n" + helpText());
    return 1;
  }
  const { cap, rest } = resolved;

  const argObj: Record<string, string> = {};
  cap.args.forEach((spec, i) => {
    if (rest[i] != null) argObj[spec.name] = rest[i];
  });
  const missing = cap.args.filter((s) => s.required && argObj[s.name] == null);
  if (missing.length) {
    console.error(`Missing required: ${missing.map((m) => m.name).join(", ")}`);
    return 1;
  }

  try {
    const result = await cap.handler(argObj, defaultDeps);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    console.error((e as Error).message ?? String(e));
    return 1;
  }
}
