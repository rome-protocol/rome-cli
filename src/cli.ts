import { CAPABILITIES, resolveCli, type Capability } from "./core/capabilities.js";
import { defaultDeps } from "./core/deps.js";
import { PKG_VERSION } from "./core/version.js";

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

/** Per-command usage: `rome <cmd> --help` — the usage line, summary, and each arg. */
function capHelpText(cap: Capability): string {
  const usage = cap.args.map((x) => (x.required ? `<${x.name}>` : `[${x.name}]`)).join(" ");
  const tag = cap.kind === "action" ? "  [needs ROME_EVM_KEY]" : "";
  const lines = [`Usage: rome ${cap.cliPath}${usage ? " " + usage : ""}${tag}`, "", `  ${cap.summary}`];
  if (cap.args.length) {
    lines.push("", "Args:");
    for (const a of cap.args) {
      lines.push(`  ${a.name.padEnd(12)} ${a.required ? "(required)" : "(optional)"}  ${a.description}`);
    }
  }
  return lines.join("\n");
}

/** Group usage: `rome <group>` / `rome <group> --help` — that group's commands only. */
function groupHelpText(group: string): string {
  const lines = [`Usage: rome ${group} <command> [args]`, "", "Commands:"];
  for (const c of CAPABILITIES.filter((x) => !x.verb && x.group === group)) {
    const a = c.args.map((x) => (x.required ? `<${x.name}>` : `[${x.name}]`)).join(" ");
    lines.push(`  rome ${c.cliPath}${a ? " " + a : ""}\n      ${c.summary}`);
  }
  return lines.join("\n");
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
    console.log(PKG_VERSION);
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
    // A bare group or `<group> --help` is a help request; an unknown subcommand
    // gets the error scoped to that group's commands, not the full catalog.
    const isGroup = CAPABILITIES.some((c) => !c.verb && c.group === first);
    if (isGroup) {
      const second = args[1];
      if (second === undefined || second === "--help" || second === "-h" || second === "help") {
        console.log(groupHelpText(first));
        return 0;
      }
      console.error(`Unknown command: rome ${args.slice(0, 2).join(" ")}`);
      console.error("\n" + groupHelpText(first));
      return 1;
    }
    console.error(`Unknown command: rome ${args.slice(0, 2).join(" ")}`);
    console.error("\n" + helpText());
    return 1;
  }
  const { cap, rest } = resolved;

  // Each declared arg can be given positionally OR as `--name value`; bare `--name`
  // is a boolean flag ("true"). Positionals fill declared args left-to-right; any
  // extra `--flag` is carried through so handlers can read it.
  const { positionals, flags } = parseRest(rest);
  if (flags.help !== undefined || flags.h !== undefined) {
    console.log(capHelpText(cap));
    return 0;
  }
  const argObj: Record<string, string> = {};
  let pi = 0;
  for (const spec of cap.args) {
    if (flags[spec.name] !== undefined) argObj[spec.name] = flags[spec.name];
    else if (positionals[pi] !== undefined) argObj[spec.name] = positionals[pi++];
  }
  if (pi < positionals.length) {
    console.error(`Unexpected extra argument(s): ${positionals.slice(pi).join(" ")}`);
    if (cap.args.some((s) => s.name === "args")) {
      console.error(`Function args are passed comma-separated in ONE argument, e.g. "0xRecipient…,42".`);
    }
    console.error(`See: rome ${cap.cliPath} --help`);
    return 1;
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
