import { describe, it, expect, vi, afterEach } from "vitest";
import { main } from "../src/cli.js";

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
});
