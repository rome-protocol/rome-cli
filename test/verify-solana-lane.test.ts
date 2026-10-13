import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import { generatePrivateKey } from "viem/accounts";

// Behaviour of the Solana lane of `verify --path solidity` with the SDK mocked:
// the v1 deps shape, provisioning order, and the receipt-status checks.

const sdk = vi.hoisted(() => ({
  submitRomeTxV1: vi.fn(),
  isSyntheticProvisioned: vi.fn(),
}));

vi.mock("@rome-protocol/sdk", async (orig) => {
  const real = await orig<typeof import("@rome-protocol/sdk")>();
  return { ...real, submitRomeTxV1: sdk.submitRomeTxV1, isSyntheticProvisioned: sdk.isSyntheticProvisioned };
});

import { defaultVerifyDeps } from "../src/core/verify.js";

const PROBE = "0xprobe00000000000000000000000000000000abcd" as `0x${string}`;

describe("verify solidity — Solana lane (v1) behaviour", () => {
  let savedEvm: string | undefined;
  let savedSol: string | undefined;
  let kp: Keypair;

  beforeEach(() => {
    savedEvm = process.env.ROME_EVM_KEY;
    savedSol = process.env.ROME_SOLANA_KEY;
    kp = Keypair.generate();
    process.env.ROME_EVM_KEY = generatePrivateKey();
    process.env.ROME_SOLANA_KEY = JSON.stringify(Array.from(kp.secretKey));
    sdk.submitRomeTxV1.mockReset();
    sdk.isSyntheticProvisioned.mockReset();
  });
  afterEach(() => {
    if (savedEvm !== undefined) process.env.ROME_EVM_KEY = savedEvm;
    else delete process.env.ROME_EVM_KEY;
    if (savedSol !== undefined) process.env.ROME_SOLANA_KEY = savedSol;
    else delete process.env.ROME_SOLANA_KEY;
  });

  it("passes the v1 deps, and skips the create step when the account exists", async () => {
    sdk.isSyntheticProvisioned.mockResolvedValue(true);
    sdk.submitRomeTxV1.mockResolvedValue({ hash: "0xaa", receipt: { status: "0x1" } });
    await defaultVerifyDeps("hadrian").solanaLaneSet(PROBE, 43n);
    expect(sdk.submitRomeTxV1).toHaveBeenCalledTimes(1);
    const [deps, call] = sdk.submitRomeTxV1.mock.calls[0];
    expect(Object.keys(deps).sort()).toEqual(["chainId", "connection", "programId", "proxyUrl", "signer"]);
    expect(deps.signer.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(call.to).toBe(PROBE);
  });

  it("creates the sender's account first, only when it is missing", async () => {
    sdk.isSyntheticProvisioned.mockResolvedValue(false);
    sdk.submitRomeTxV1.mockResolvedValue({ hash: "0xaa", receipt: { status: "0x1" } });
    await defaultVerifyDeps("hadrian").solanaLaneSet(PROBE, 43n);
    expect(sdk.submitRomeTxV1).toHaveBeenCalledTimes(2);
    expect(sdk.submitRomeTxV1.mock.calls[0][1].to).not.toBe(PROBE);
    expect(sdk.submitRomeTxV1.mock.calls[1][1].to).toBe(PROBE);
  });

  it("a failed create stops before the probe call and names the status", async () => {
    sdk.isSyntheticProvisioned.mockResolvedValue(false);
    sdk.submitRomeTxV1.mockResolvedValueOnce({ hash: "0xbb", receipt: { status: "0x0" } });
    await expect(defaultVerifyDeps("hadrian").solanaLaneSet(PROBE, 43n)).rejects.toThrow(/creating.*0xbb.*status 0x0/s);
    expect(sdk.submitRomeTxV1).toHaveBeenCalledTimes(1);
  });

  it("a create with no receipt in time says so rather than 'failed' alone", async () => {
    sdk.isSyntheticProvisioned.mockResolvedValue(false);
    sdk.submitRomeTxV1.mockResolvedValueOnce({ hash: "0xcc", receipt: null });
    await expect(defaultVerifyDeps("hadrian").solanaLaneSet(PROBE, 43n)).rejects.toThrow(/no receipt in time/);
  });

  it("a reverted or missing receipt on the probe call throws", async () => {
    sdk.isSyntheticProvisioned.mockResolvedValue(true);
    sdk.submitRomeTxV1.mockResolvedValueOnce({ hash: "0xdd", receipt: { status: "0x0" } });
    await expect(defaultVerifyDeps("hadrian").solanaLaneSet(PROBE, 43n)).rejects.toThrow(/did not succeed.*0x0/s);
    sdk.submitRomeTxV1.mockResolvedValueOnce({ hash: "0xee", receipt: null });
    await expect(defaultVerifyDeps("hadrian").solanaLaneSet(PROBE, 43n)).rejects.toThrow(/no receipt in time/);
  });
});
