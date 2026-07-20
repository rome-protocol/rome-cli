# rome-cli — architecture & reference

`rome` gives a builder — human or AI agent — **grounded Rome facts** and the **right build pattern**, through two aligned surfaces over one capability core. This document explains how it's put together, how to run it, every capability, and the security model.

## The shape: one core, two surfaces

```
              ┌──────────── capability core (read-only) ─────────────┐
              │  facts:   chain · tokens · contracts · gas · balance  │
              │           · programs         (registry + RPC)         │
              │  cookbook: cpi-recipe · patterns   (SDK + curated)    │
              └───────────────┬────────────────────┬─────────────────┘
                 rome <group> <cmd>            rome mcp
                 (CLI — humans + agent           (stdio MCP server —
                  shell-outs; one-shot)           MCP-native agents)
```

Both surfaces are generated from a **single `CAPABILITIES` registry** (`src/core/capabilities.ts`). A capability's CLI command (`facts chain`) and its MCP tool (`facts_chain`) are the *same* handler with the *same* name-stem — so the two surfaces cannot drift. That invariant is asserted by a test (`test/alignment.test.ts`) and a behavioral test that drives the real CLI dispatch (`test/cli.test.ts`).

## Running it — CLI vs MCP server

**You never host a server.** There is one binary, `rome`, with two entry modes:

### CLI — standalone, one-shot
```bash
rome facts chain hadrian      # prints JSON, process exits
rome cookbook patterns lending
```
Each invocation is its own short-lived process. Nothing stays running. Pipe the JSON to `jq`, or let an agent shell out to `rome …` and read stdout.

### MCP — a stdio server your client launches for you
`rome mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server over **stdio** (stdin/stdout) — **not** a network daemon. You do **not** run it yourself or host it anywhere. You register it once in an MCP client:

```json
{
  "mcpServers": {
    "rome": { "command": "rome", "args": ["mcp"] }
  }
}
```

The client (Claude Code, Claude Desktop, Cursor, …) spawns `rome mcp` as a **child process on demand**, speaks JSON-RPC to it over stdin/stdout, and terminates it when the session ends. The process stays alive only while the client holds its stdin open. No port, no hosting, no process manager. The MCP server exposes each capability as a tool (`facts_chain`, `facts_gas`, `cookbook_cpi_recipe`, …).

**When to use which:** a person or a shell script → the CLI. An MCP-native agent → configure `rome mcp` and call the tools. Same capabilities, same data, either way.

## Capabilities

All read-only. Facts resolve against the public `@rome-protocol/registry` (Hadrian + Martius) and the chain's RPC; the cookbook is grounded on the SDK's real values + a curated index.

### `facts` — grounded chain facts (kills hallucination)

| CLI | MCP tool | What it returns | Source |
|---|---|---|---|
| `rome facts chain <id>` | `facts_chain` | chain id, RPC, explorer, rome-evm program id, gas token | registry `getChain` |
| `rome facts tokens <id>` | `facts_tokens` | token list (address, mint, symbol, decimals, kind) + match-by-mint note | registry `getTokens` |
| `rome facts contracts <id>` | `facts_contracts` | deployed contract addresses | registry `getContracts` |
| `rome facts gas <id>` | `facts_gas` | live gas price + the estimate-over-predicts / exact-charge / ~1.48M-native-transfer caveats | RPC `eth_gasPrice` |
| `rome facts balance <id> <addr>` | `facts_balance` | native (gas-token) balance for an address | RPC `eth_getBalance` |
| `rome facts programs <network>` | `facts_programs` | Solana program ids for `devnet`/`testnet`/`mainnet` | registry `getPrograms` |

Chains resolve by id, name, or slug (`200010`, `hadrian`, `200010-hadrian`, `Rome Hadrian`) — by **exact** match, so an ambiguous prefix or a bad id fails loudly rather than returning the wrong chain.

### `cookbook` — the right pattern (kills "don't know how")

| CLI | MCP tool | What it returns | Source |
|---|---|---|---|
| `rome cookbook cpi-recipe [program]` | `cookbook_cpi_recipe` | the CPI account-rules agents get wrong (accounts non-empty; operator + program_id excluded; sign as `HELPER.pda(address(this))`, not `tx.origin`) + the SDK encoders + real precompile addresses | `@rome-protocol/sdk` `PRECOMPILE_ADDRESSES` |
| `rome cookbook patterns [goal]` | `cookbook_patterns` | which example repo + guide fits a goal (lending → aerarium; AMM → rome-dex; CPI → cardo; from-home → appia; oracle → oracle-gateway; scaffold → create-rome-app) | curated index |

## Grounding — why the facts are trustworthy

Every value comes from a real source, never a model's memory:
- **Chain facts** — `@rome-protocol/registry` (the generated, public projection) + the chain's own RPC.
- **Precompile addresses** in the CPI recipe — imported from `@rome-protocol/sdk`'s `PRECOMPILE_ADDRESSES` constant, not hardcoded here.
- **The pattern index** — a small curated map that mirrors the [ecosystem map](https://docs.rome.builders/getting-started/ecosystem).

If the registry doesn't publish a chain, `rome facts` says so (with the known set) instead of guessing.

## Security model

**Read-only by charter — the tool holds no keys and cannot sign.**
- No capability writes, signs, or sends a transaction. Every one is a read.
- The code imports `viem` only as `createPublicClient` (reads: `getGasPrice`/`getBalance`) and `@rome-protocol/sdk` only for the `PRECOMPILE_ADDRESSES` **constant** — no signer, no wallet client, no encoder is ever invoked to submit.
- **Zero `process.env` reads** — the tool cannot pick up a private key.

This is *why* the read/act split runs along the surface boundary: the **MCP server is safe to wire into any agent** — it can never leak a secret or move funds. When write actions land (see below), they are **CLI-only**, with the key supplied via the local environment, never through MCP.

## Project layout

```
src/
  core/
    capabilities.ts   the single CAPABILITIES registry (both surfaces read this)
    facts.ts          chain/token/contract/gas/balance/programs handlers + resolveChainId
    cookbook.ts       cpi-recipe + patterns handlers + the curated index
    deps.ts           injectable RPC client (viem public client; stubbed in tests)
  cli.ts              `rome <group> <cmd>` dispatch (exported main; no side effects on import)
  mcp.ts              `rome mcp` — registers each capability as an MCP tool over stdio
  bin.ts              the `rome` binary entry (only file that runs on invocation)
test/                 facts + cookbook + alignment + behavioral CLI tests (+ scripts/mcp-smoke.mjs e2e)
```

## Extending — v1.1 (planned)

v1 is **grounding-first** (read-only). The next tier adds Rome-*unique* actions to the **CLI only**:
- `rome fund` — bridge USDC into a Rome chain (the funding on-ramp; no faucet).
- `rome verify` — the funded both-lane works-gate (fund → deploy → act → assert).

Deploy stays with Foundry / Hardhat / `create-rome-app` — `rome` does not re-wrap them. Actions take the signing key from the local environment, never a flag and never through the MCP server.
