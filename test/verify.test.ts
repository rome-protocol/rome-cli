import { describe, it, expect, vi } from "vitest";
import {
  runVerifySolidity,
  runVerifySolanaProgram,
  runVerifyFromHome,
  verifyHandler,
  defaultVerifyDeps,
  defaultVerifySolanaProgramDeps,
  type VerifyDeps,
  type VerifySolanaProgramDeps,
  type VerifyFromHomeDeps,
} from "../src/core/verify.js";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";

// `verify --path solidity` — the both-lane works-gate: deploy a probe, drive set/get
// from the EVM lane (submitRomeTx) AND the Solana lane (submitRomeTxSolanaLane), assert
// the SAME contract answers on each. A funded ACTION (both keys); CLI-only, never MCP.
// These tests pin the orchestration + parity logic with mocked lane ops (no network).

function deps(reads: bigint[], order: string[]): VerifyDeps {
  let i = 0;
  return {
    deployProbe: vi.fn(async () => {
      order.push("deploy");
      return "0xprobe00000000000000000000000000000000abcd" as `0x${string}`;
    }),
    evmLaneSet: vi.fn(async () => void order.push("evmSet")),
    solanaLaneSet: vi.fn(async () => void order.push("solanaSet")),
    read: vi.fn(async () => {
      order.push("read");
      return reads[i++];
    }),
  };
}

describe("runVerifySolidity — both-lane works-gate", () => {
  it("GREEN when both lanes drive the same contract (deploy → evm set/read → solana set/read)", async () => {
    const order: string[] = [];
    const r = await runVerifySolidity(deps([42n, 43n], order));
    expect(order).toEqual(["deploy", "evmSet", "read", "solanaSet", "read"]);
    expect(r.ok).toBe(true);
    expect(r.probe).toMatch(/^0x/);
    expect(r.checks.map((c) => [c.lane, c.ok])).toEqual([
      ["evm", true],
      ["solana", true],
    ]);
  });

  it("RED when the EVM lane write doesn't land", async () => {
    const r = await runVerifySolidity(deps([0n, 43n], []));
    expect(r.checks.find((c) => c.lane === "evm")?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("RED when the Solana lane write doesn't land", async () => {
    const r = await runVerifySolidity(deps([42n, 42n], []));
    expect(r.checks.find((c) => c.lane === "solana")?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });
});

// `verify --path solana-program` — EVM-lane-drives-Solana-program-via-CPI gate.
// Deploy the CPI wrapper probe, `ping` it (EVM lane) → the probe CPIs SPL Memo. A
// successful EVM receipt IS the proof (a failed CPI reverts the tx). EVM key only.
// The Solana-log confirmation (`confirmMemo`) is an opt-in deep check (`--solana-rpc`).
function spDeps(over: Partial<VerifySolanaProgramDeps>, order: string[] = []): VerifySolanaProgramDeps {
  return {
    deployProbe: vi.fn(async () => {
      order.push("deploy");
      return "0xprobe00000000000000000000000000000000abcd" as `0x${string}`;
    }),
    ping: vi.fn(async () => {
      order.push("ping");
      return { hash: "0xpingaaaa00000000000000000000000000000000000000000000000000000000" as `0x${string}`, success: true };
    }),
    ...over,
  };
}

describe("runVerifySolanaProgram — EVM drives a Solana program via CPI", () => {
  it("GREEN when the ping tx lands (EVM receipt success); no Solana RPC required", async () => {
    const order: string[] = [];
    const r = await runVerifySolanaProgram(spDeps({}, order));
    expect(order).toEqual(["deploy", "ping"]);
    expect(r.path).toBe("solana-program");
    expect(r.cpiLanded).toBe(true);
    expect(r.memoConfirmed).toBeUndefined(); // deep check not run
    expect(r.ok).toBe(true);
  });

  it("RED when the ping tx reverts (a failed CPI reverts the EVM tx)", async () => {
    const r = await runVerifySolanaProgram(
      spDeps({ ping: vi.fn(async () => ({ hash: "0xdead00000000000000000000000000000000000000000000000000000000beef" as `0x${string}`, success: false })) }),
    );
    expect(r.cpiLanded).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("deep check GREEN: ok requires the memo in the Solana settlement logs when confirmMemo is present", async () => {
    const r = await runVerifySolanaProgram(spDeps({ confirmMemo: vi.fn(async () => ({ settlement: "5Lwke7Wsig", found: true })) }));
    expect(r.memoConfirmed).toBe(true);
    expect(r.solanaSettlement).toBe("5Lwke7Wsig");
    expect(r.ok).toBe(true);
  });

  it("deep check RED: tx lands but the memo is NOT in the logs → not ok", async () => {
    const r = await runVerifySolanaProgram(spDeps({ confirmMemo: vi.fn(async () => ({ found: false })) }));
    expect(r.cpiLanded).toBe(true);
    expect(r.memoConfirmed).toBe(false);
    expect(r.ok).toBe(false);
  });
});

// `verify --path from-home` — the round-trip works-gate: bridge USDC IN (wrapper) →
// act with it on Rome (wUSDC self-transfer) → bridge OUT to attestation-ready. Legs run
// in order and FAIL FAST (a red leg stops the gate). The out-leg asserts to
// attestation-ready + claim handle — the destination claim is the user's own step.
function fhDeps(over: Partial<VerifyFromHomeDeps>, order: string[] = []): VerifyFromHomeDeps {
  return {
    bridgeIn: vi.fn(async () => {
      order.push("in");
      return { txHash: "0xin", landed: true, wusdcDelta: 200000n };
    }),
    act: vi.fn(async () => {
      order.push("act");
      return { hash: "0xact" as `0x${string}`, success: true };
    }),
    bridgeOut: vi.fn(async () => {
      order.push("out");
      return { burnTxHash: "0xburn", claimReady: true };
    }),
    ...over,
  };
}

describe("runVerifyFromHome — the round-trip works-gate", () => {
  it("GREEN: in (wUSDC landed) → act → out (claim-ready), in order", async () => {
    const order: string[] = [];
    const r = await runVerifyFromHome(fhDeps({}, order));
    expect(order).toEqual(["in", "act", "out"]);
    expect(r.path).toBe("from-home");
    expect(r.legs.in.ok).toBe(true);
    expect(r.legs.act?.ok).toBe(true);
    expect(r.legs.out?.ok).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("RED + fail-fast: inbound lands no wUSDC → act/out never run", async () => {
    const order: string[] = [];
    const d = fhDeps({ bridgeIn: vi.fn(async () => ({ txHash: "0xin", landed: true, wusdcDelta: 0n })) }, order);
    const r = await runVerifyFromHome(d);
    expect(r.legs.in.ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(d.act).not.toHaveBeenCalled();
    expect(d.bridgeOut).not.toHaveBeenCalled();
  });

  it("RED + fail-fast: act reverts → out never runs", async () => {
    const d = fhDeps({ act: vi.fn(async () => ({ hash: "0xbad" as `0x${string}`, success: false })) });
    const r = await runVerifyFromHome(d);
    expect(r.legs.act?.ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(d.bridgeOut).not.toHaveBeenCalled();
  });

  it("RED: out-leg not claim-ready → gate fails", async () => {
    const r = await runVerifyFromHome(fhDeps({ bridgeOut: vi.fn(async () => ({ burnTxHash: "0xburn", claimReady: false })) }));
    expect(r.legs.out?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });
});

describe("verifyHandler --path from-home arg contract", () => {
  it("requires --from and --amount with a clear error (before any network call)", async () => {
    const pe = process.env.ROME_EVM_KEY;
    process.env.ROME_EVM_KEY = `0x${"11".repeat(32)}`;
    try {
      await expect(verifyHandler({ chain: "hadrian", path: "from-home" })).rejects.toThrow(/--from/);
      await expect(verifyHandler({ chain: "hadrian", path: "from-home", from: "sepolia" })).rejects.toThrow(/--amount/);
    } finally {
      if (pe !== undefined) process.env.ROME_EVM_KEY = pe;
      else delete process.env.ROME_EVM_KEY;
    }
  });
});

describe("verify is a key-gated action, never on MCP", () => {
  it("registered as an action requiring a key, and absent from the MCP surface", () => {
    const cap = CAPABILITIES.find((c) => c.id === "verify.verify");
    expect(cap?.kind).toBe("action");
    expect(cap?.requiresKey).toBe(true);
    expect(cap?.verb).toBe(true);
    expect(new Set(buildMcpTools().map((t) => t.name)).has("verify")).toBe(false);
  });

  it("refuses without keys before any network call", async () => {
    const pe = process.env.ROME_EVM_KEY;
    const ps = process.env.ROME_SOLANA_KEY;
    delete process.env.ROME_EVM_KEY;
    delete process.env.ROME_SOLANA_KEY;
    try {
      await expect(verifyHandler({ chain: "hadrian", path: "solidity" })).rejects.toThrow(/ROME_(EVM|SOLANA)_KEY/);
    } finally {
      if (pe !== undefined) process.env.ROME_EVM_KEY = pe;
      if (ps !== undefined) process.env.ROME_SOLANA_KEY = ps;
    }
  });

  it("per-path key scoping: solidity needs the Solana key; solana-program needs only ROME_EVM_KEY", () => {
    const pe = process.env.ROME_EVM_KEY;
    const ps = process.env.ROME_SOLANA_KEY;
    process.env.ROME_EVM_KEY = `0x${"11".repeat(32)}`;
    delete process.env.ROME_SOLANA_KEY;
    try {
      // solidity drives BOTH lanes → demands the Solana key up front
      expect(() => defaultVerifyDeps("hadrian")).toThrow(/ROME_SOLANA_KEY/);
      // solana-program is EVM-lane only → builds with just the EVM key, no Solana key
      expect(() => defaultVerifySolanaProgramDeps("hadrian")).not.toThrow();
    } finally {
      if (pe !== undefined) process.env.ROME_EVM_KEY = pe;
      else delete process.env.ROME_EVM_KEY;
      if (ps !== undefined) process.env.ROME_SOLANA_KEY = ps;
    }
  });
});
