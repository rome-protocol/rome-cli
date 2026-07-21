import { CAPABILITIES, resolveCli } from "./core/capabilities.js";
import { defaultDeps } from "./core/deps.js";

const VERSION = "0.1.0";

/** Every CLI invocation path the CLI dispatches ("facts chain", "deploy", …). */
export function cliCommandTable(): string[] {
  return CAPABILITIES.map((c) => c.cliPath);
}

/**
 * Split a command's trailing argv into ordered positionals and `--flag` values.
 * `--name value` → { name: value }; a bare `--name` (end, or followed by another
 * `--flag`) → { name: "true" } (boolean). Positionals keep their order.
 */
export function parseRest(rest: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t.startsWith("--")) {
      const name = t.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = "true";
      }
    } else {
      positionals.push(t);
    }
  }
  return { positionals, flags };
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

  // Each declared arg can be given positionally OR as `--name value`; bare `--name`
  // is a boolean flag ("true"). Positionals fill declared args left-to-right; any
  // extra `--flag` is carried through so handlers can read it.
  const { positionals, flags } = parseRest(rest);
  const argObj: Record<string, string> = {};
  let pi = 0;
  for (const spec of cap.args) {
    if (flags[spec.name] !== undefined) argObj[spec.name] = flags[spec.name];
    else if (positionals[pi] !== undefined) argObj[spec.name] = positionals[pi++];
  }
  for (const [k, v] of Object.entries(flags)) if (!(k in argObj)) argObj[k] = v;

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
