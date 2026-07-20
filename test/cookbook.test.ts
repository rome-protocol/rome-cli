import { describe, it, expect } from "vitest";
import { getCpiRecipe, getPatterns } from "../src/core/cookbook.js";

describe("getCpiRecipe", () => {
  const r = getCpiRecipe() as {
    precompiles: Record<string, string>;
    accountRules: string[];
    encoders: Record<string, string>;
  };
  it("grounds the precompile addresses from the SDK (not hallucinated)", () => {
    // Real values from @rome-protocol/sdk PRECOMPILE_ADDRESSES.
    expect(r.precompiles.cpi).toBe("0xff00000000000000000000000000000000000008");
    expect(r.precompiles.helper).toBe("0xff00000000000000000000000000000000000009");
    expect(r.precompiles.withdraw).toBe("0x4200000000000000000000000000000000000016");
  });
  it("states the account rules agents get wrong", () => {
    const joined = r.accountRules.join(" ").toLowerCase();
    expect(joined).toMatch(/non-empty/);
    expect(joined).toMatch(/program_id/);
    expect(joined).toMatch(/msg\.sender/);
  });
  it("points at the SDK encoders", () => {
    expect(r.encoders.invoke).toMatch(/encodeInvoke/);
    expect(r.encoders.invokeSigned).toMatch(/encodeInvokeSigned/);
  });
});

describe("getPatterns", () => {
  it("returns the full goal→repo index when no goal is given", () => {
    const all = getPatterns() as Array<{ repo: string }>;
    expect(all.length).toBeGreaterThanOrEqual(5);
    const repos = all.map((p) => p.repo);
    expect(repos).toContain("rome-dex");
    expect(repos).toContain("aerarium");
    expect(repos).toContain("create-rome-app");
  });
  it("filters by goal keyword", () => {
    const lending = getPatterns("lending") as Array<{ repo: string }>;
    expect(lending.length).toBeGreaterThanOrEqual(1);
    expect(lending.map((p) => p.repo)).toContain("aerarium");
  });
});
