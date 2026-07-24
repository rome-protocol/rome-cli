import { describe, it, expect, vi, afterEach } from "vitest";
import { main, parseRest } from "../src/cli.js";
import { readFileSync } from "node:fs";

// Drive the REAL CLI dispatch (findCapability + positional-arg mapping + exit codes),
// not just the capability table — this is the behavioral half of the alignment gate.

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  return { out, err, restore: () => { logSpy.mockRestore(); errSpy.mockRestore(); } };
}

afterEach(() => vi.restoreAllMocks());

describe("CLI dispatch (main)", () => {
  it("routes `facts chain` by full name to the right chain and exits 0", async () => {
    const c = capture();
    const code = await main(["node", "rome", "facts", "chain", "Rome Hadrian"]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out.join("\n"));
    expect(parsed.chainId).toBe(200010);
  });

  it("routes `cookbook patterns` and returns the matching repo", async () => {
    const c = capture();
    const code = await main(["node", "rome", "cookbook", "patterns", "amm"]);
    c.restore();
    expect(code).toBe(0);
    expect(c.out.join("\n")).toMatch(/rome-dex/);
  });

  it("dispatches a single verb command (rome send, no key → exit 1 with a clear error)", async () => {
    const prev = process.env.ROME_EVM_KEY;
    delete process.env.ROME_EVM_KEY;
    const c = capture();
    const code = await main(["node", "rome", "send", "hadrian", "0x0000000000000000000000000000000000000001", "deposit(uint256)", "1"]);
    c.restore();
    if (prev !== undefined) process.env.ROME_EVM_KEY = prev;
    expect(code).toBe(1);
    expect(c.err.join("\n")).toMatch(/ROME_EVM_KEY/);
  });

  it("errors (exit 1) on a missing required arg", async () => {
    const c = capture();
    const code = await main(["node", "rome", "facts", "chain"]);
    c.restore();
    expect(code).toBe(1);
    expect(c.err.join("\n")).toMatch(/missing required/i);
  });

  it("errors (exit 1) on an unknown command", async () => {
    const c = capture();
    const code = await main(["node", "rome", "bogus", "cmd"]);
    c.restore();
    expect(code).toBe(1);
    expect(c.err.join("\n")).toMatch(/unknown command/i);
  });

  it("prints help and exits 0 with no args", async () => {
    const c = capture();
    const code = await main(["node", "rome"]);
    c.restore();
    expect(code).toBe(0);
    expect(c.out.join("\n")).toMatch(/rome mcp/);
  });

  it("maps --flag value + boolean --flag through to the handler (fund, no key → exit 1 on the KEY, proving from/amount parsed)", async () => {
    const prev = process.env.ROME_EVM_KEY;
    delete process.env.ROME_EVM_KEY;
    const c = capture();
    const code = await main(["node", "rome", "fund", "hadrian", "--from", "base sepolia", "--amount", "0.01"]);
    c.restore();
    if (prev !== undefined) process.env.ROME_EVM_KEY = prev;
    expect(code).toBe(1);
    // if the flags hadn't parsed we'd fail earlier on "missing required from/amount"
    expect(c.err.join("\n")).toMatch(/ROME_EVM_KEY/);
    expect(c.err.join("\n")).not.toMatch(/missing required/i);
  });
});

describe("parseRest (positionals + --flags)", () => {
  it("keeps positionals ordered and captures --name value", () => {
    expect(parseRest(["hadrian", "--from", "base-sepolia", "--amount", "0.01"])).toEqual({
      positionals: ["hadrian"],
      flags: { from: "base-sepolia", amount: "0.01" },
    });
  });
  it("treats a bare --flag (at end or before another flag) as boolean true", () => {
    expect(parseRest(["--dry-run"])).toEqual({ positionals: [], flags: { "dry-run": "true" } });
    expect(parseRest(["--dry-run", "--amount", "1"])).toEqual({
      positionals: [],
      flags: { "dry-run": "true", amount: "1" },
    });
  });
  it("preserves pure-positional invocations unchanged", () => {
    expect(parseRest(["hadrian", "0xabc", "deposit(uint256)", "1"])).toEqual({
      positionals: ["hadrian", "0xabc", "deposit(uint256)", "1"],
      flags: {},
    });
  });
});

describe("CLI guardrails — extra positionals, per-command help, version", () => {
  it("errors (exit 1) on extra positional args instead of silently dropping them", async () => {
    const c = capture();
    const code = await main([
      "node", "rome", "call", "hadrian",
      "0x0000000000000000000000000000000000000001",
      "allowance(address,address) returns (uint256)",
      "0x0000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000003",
    ]);
    c.restore();
    expect(code).toBe(1);
    expect(c.err.join("\n")).toMatch(/unexpected extra argument/i);
    expect(c.err.join("\n")).toMatch(/comma-separated/i);
  });

  it("prints per-command usage on `rome call --help` and exits 0", async () => {
    const c = capture();
    const code = await main(["node", "rome", "call", "--help"]);
    c.restore();
    expect(code).toBe(0);
    const out = c.out.join("\n");
    expect(out).toMatch(/rome call <chain> <address> <signature> \[args\]/);
    expect(out).toMatch(/comma-separated/i);
  });

  it("prints per-command usage for a two-word command (`rome facts chain --help`)", async () => {
    const c = capture();
    const code = await main(["node", "rome", "facts", "chain", "--help"]);
    c.restore();
    expect(code).toBe(0);
    expect(c.out.join("\n")).toMatch(/rome facts chain <chain>/);
  });

  it("prints group usage on `rome cookbook --help` and exits 0 (not 'Unknown command')", async () => {
    const c = capture();
    const code = await main(["node", "rome", "cookbook", "--help"]);
    c.restore();
    expect(code).toBe(0);
    expect(c.err.join("\n")).not.toMatch(/unknown command/i);
    const out = c.out.join("\n");
    expect(out).toMatch(/rome cookbook cpi-recipe/);
    expect(out).toMatch(/rome cookbook errors/);
  });

  it("treats a bare group (`rome facts`) as a help request, exit 0", async () => {
    const c = capture();
    const code = await main(["node", "rome", "facts"]);
    c.restore();
    expect(code).toBe(0);
    expect(c.err.join("\n")).not.toMatch(/unknown command/i);
    expect(c.out.join("\n")).toMatch(/rome facts chain <chain>/);
  });

  it("scopes the error help to the group on an unknown subcommand (`rome facts bogus`)", async () => {
    const c = capture();
    const code = await main(["node", "rome", "facts", "bogus"]);
    c.restore();
    expect(code).toBe(1);
    const err = c.err.join("\n");
    expect(err).toMatch(/unknown command: rome facts bogus/i);
    expect(err).toMatch(/rome facts chain/);
    expect(err).not.toMatch(/rome deploy/); // scoped to the group, not the full catalog
  });

  it("--version prints the real package version, not a hardcoded string", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const c = capture();
    const code = await main(["node", "rome", "--version"]);
    c.restore();
    expect(code).toBe(0);
    expect(c.out.join("\n").trim()).toBe(pkg.version);
  });
});
