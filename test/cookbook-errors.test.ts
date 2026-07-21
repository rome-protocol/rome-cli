import { describe, it, expect } from "vitest";
import { getErrors } from "../src/core/cookbook.js";
import { CAPABILITIES } from "../src/core/capabilities.js";
import { buildMcpTools } from "../src/mcp.js";

// `cookbook errors` — the net-new Rome error taxonomy: decode a failure → cause + fix.
// A read (CLI + MCP), same shape as `cookbook patterns`: filter by query, else the full list.

describe("cookbook errors — the Rome error taxonomy", () => {
  it("returns the full taxonomy with no query; every entry has symptom/cause/fix", () => {
    const all = getErrors();
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const e of all) {
      expect(e.symptom).toBeTruthy();
      expect(e.cause).toBeTruthy();
      expect(e.fix).toBeTruthy();
    }
  });

  it("filters by symptom / tag", () => {
    const s = (e: { symptom: string; cause: string; fix: string }) => `${e.symptom} ${e.cause} ${e.fix}`;
    expect(getErrors("gas").some((e) => /estimate/i.test(s(e)))).toBe(true);
    expect(getErrors("cpi").some((e) => /iterative/i.test(s(e)))).toBe(true);
    expect(getErrors("UnknownInstruction").some((e) => /instruction/i.test(e.symptom))).toBe(true);
  });

  it("falls back to the full list on an unknown query (agent still sees everything)", () => {
    expect(getErrors("zzzz-nope").length).toBe(getErrors().length);
  });
});

describe("cookbook errors is a read capability on MCP", () => {
  it("registered as a read + present on the MCP surface", () => {
    const cap = CAPABILITIES.find((c) => c.id === "cookbook.errors");
    expect(cap?.kind).toBe("read");
    expect(cap?.requiresKey).toBe(false);
    expect(new Set(buildMcpTools().map((t) => t.name)).has("cookbook_errors")).toBe(true);
  });
});
