# rome-cli — architecture & reference

`rome` carries a builder — human or AI agent — across the whole build-on-Rome lifecycle through **two aligned surfaces over one capability core**: grounded facts, the right pattern, contract calls, the Rome-unique on-ramp (`fund`/`bridge`), deploy/send, cross-VM diagnosis, and the both-lane works-gate (`verify`). This document explains how it's put together, how to run it, every capability, and the security model.

## The shape: one core, two surfaces, two kinds

```
        ┌───────────────── capability core (src/core/capabilities.ts) ─────────────────┐
        │  READS (no keys):   facts · cookbook · call · doctor · tx · preset            │
        │  ACTIONS (CLI-only): new · deploy · send · fund · bridge · activate · verify   │
        └───────────────────────────┬───────────────────────────┬─────────────────────┘
                       rome <cmd>  (CLI — all commands)      rome mcp  (stdio MCP server)
                       humans + agent shell-outs             MCP-native agents — READS ONLY
```

Both surfaces are generated from a **single `CAPABILITIES` registry**. Each capability declares a **kind**:

- **`read`** — a pure lookup or diagnosis; **holds no key**; exposed on **both** the CLI and the MCP server.
- **`action`** — writes/signs on-chain; **CLI-only and key-gated** (the signing key comes from the environment); **never** registered as an MCP tool.

A capability's CLI command (`facts chain`) and its MCP tool (`facts_chain`) are the *same* handler with the *same* name-stem, so the surfaces cannot drift. The invariant — **MCP tools === the read capabilities, actions absent** — is asserted by `test/alignment.test.ts`, plus a behavioral test that drives the real CLI dispatch (`test/cli.test.ts`) and an end-to-end MCP client smoke (`scripts/mcp-smoke.mjs`).

## Running it — CLI vs MCP server

**You never host a server.** There is one binary, `rome`, with two entry modes:

### CLI — standalone, one-shot
```bash
rome facts chain hadrian          # prints JSON, process exits
rome fund hadrian --from base-sepolia --amount 1   # an action (needs a key; see Security)
```
Each invocation is its own short-lived process. Pipe the JSON to `jq`, or let an agent shell out to `rome …` and read stdout. Commands take positionals or `--flags` interchangeably.

### MCP — a stdio server your client launches for you
`rome mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server over **stdio** — **not** a network daemon. You do not run or host it. Register it once:

```json
{ "mcpServers": { "rome": { "command": "rome", "args": ["mcp"] } } }
```

The client (Claude Code, Claude Desktop, Cursor, …) spawns `rome mcp` as a **child process on demand**, speaks JSON-RPC over stdin/stdout, and terminates it when the session ends. No port, no hosting. It exposes **only the read capabilities** as tools — an agent gets grounded facts, patterns, diagnosis, and toolchain config, but can never sign or move funds through MCP.

**When to use which:** a person or shell script → the CLI. An MCP-native agent → configure `rome mcp` for reads, and shell out to `rome <action>` (with a key in its environment) when it needs to fund/deploy/verify.

## Capabilities

### Reads — CLI + MCP, no keys

| CLI | MCP tool | What it returns | Source |
|---|---|---|---|
| `facts chain <id>` | `facts_chain` | chain id, RPC, explorer, rome-evm program id, gas token | registry `getChain` |
| `facts tokens <id>` | `facts_tokens` | token list (address, mint, symbol, decimals, kind) | registry `getTokens` |
| `facts contracts <id>` | `facts_contracts` | deployed contract addresses | registry `getContracts` |
| `facts gas <id>` | `facts_gas` | live gas price + the estimate-vs-charge / ~1.48M-native caveats | RPC |
| `facts balance <id> <addr>` | `facts_balance` | native (gas-token) balance | RPC |
| `facts programs <network>` | `facts_programs` | Solana program ids for a network | registry `getPrograms` |
| `cookbook cpi-recipe [prog]` | `cookbook_cpi_recipe` | the CPI account-rules + SDK encoders + real precompile addresses | `@rome-protocol/sdk` |
| `cookbook patterns [goal]` | `cookbook_patterns` | which example repo + guide fits a goal | curated index |
| `cookbook errors [query]` | `cookbook_errors` | decode a Rome failure → cause + fix (the error taxonomy) | curated |
| `call <chain> <addr> <sig> [args]` | `call` | read a contract via `eth_call` | RPC |
| `doctor <chain> [--address]` | `doctor` | preflight: chain live? RPC reachable? program set? wallet funded? | registry + RPC |
| `tx <chain> <hash>` | `tx` | EVM receipt + the Solana settlement tx(s) (`rome_solanaTxForEvmTx`) + Via link | RPC |
| `preset <foundry\|hardhat> <chain>` | `preset` | ready Rome toolchain config (RPC + chainId) + quirks | registry |

Chains resolve by id, name, or slug (`200010`, `hadrian`, `Rome Hadrian`) — by **exact** match, so an ambiguous prefix or bad id fails loudly rather than returning the wrong chain.

### Actions — CLI-only, key-gated, never MCP

| CLI | Signs with | What it does |
|---|---|---|
| `deploy <chain> <artifact> [args]` | `ROME_EVM_KEY` | deploy a compiled artifact, handling Rome's gas quirks |
| `send <chain> <addr> <sig> [args]` | `ROME_EVM_KEY` | write to a contract via `submitRomeTx` (the correct Rome write path) |
| `fund <chain> --from <src> --amount <usdc>` | `ROME_EVM_KEY` | bridge USDC → Rome **gas** (CCTP); the "from home" on-ramp |
| `bridge <chain> --from <src> --amount <usdc> [--intent gas\|wrapper]` | `ROME_EVM_KEY` | bridge USDC **in** as gas or wUSDC |
| `bridge <chain> --to <dest> --amount <usdc> [--recipient 0x…]` | `ROME_EVM_KEY` | bridge wUSDC **out**: burn on Rome → claim handle for the destination (you claim there) |
| `activate <chain>` | `ROME_EVM_KEY` | one-time PDA funding required before the first bridge **out** (idempotent; inbound needs none) |
| `new <app-name> [--chain <chain>]` | *none* (keyless) | scaffold a dual-lane app — wraps `create-rome-app`, pre-wires the chain from the registry into `.env`, prints the lifecycle next-steps (fund → deploy → demo → verify). CLI-only: MCP never writes to disk |
| `verify <chain> [--path solidity]` | `ROME_EVM_KEY` + `ROME_SOLANA_KEY` | the **both-lane works-gate**: deploy a probe, drive it from the EVM lane *and* the Solana lane, assert parity |
| `verify <chain> --path solana-program` | `ROME_EVM_KEY` | the **cross-VM works-gate**: deploy a thin CPI wrapper; an EVM-lane call drives a Solana program (SPL Memo) via CPI. `--solana-rpc` adds the Solana-log deep check |
| `verify <chain> --path from-home --from <src> --amount <usdc>` | `ROME_EVM_KEY` | the **round-trip works-gate**: bridge in (wrapper) → act on Rome → bridge out to claim-ready. Waits on Circle attestation (~20 min); needs an activated account |

`fund`/`bridge` orchestrate `@rome-protocol/sdk/bridge` (quote → sign the source burn → settle → register → poll); `verify --path solidity` orchestrates `submitRomeTx` (EVM lane) + `submitRomeTxSolanaLane` (Solana lane); `verify --path solana-program` orchestrates `submitRomeTx` into a wrapper that CPIs a Solana program via the CPI precompile (`0xff…08`). Every action prints what it did; `fund`/`bridge` preview with `--dry-run`.

## Grounding — why the facts are trustworthy

Every value comes from a real source, never a model's memory: chain facts from `@rome-protocol/registry` + the chain's RPC; precompile addresses from `@rome-protocol/sdk`; the pattern index mirrors the [ecosystem map](https://docs.rome.builders/getting-started/ecosystem). If the registry doesn't publish a chain, `rome` says so (with the known set) instead of guessing.

## Security model — the read/action boundary

The read/action split runs along the **surface boundary**, and that is the whole security design:

- **Reads hold no key** and are safe to wire into any agent over MCP — they can never sign, fund, or leak a secret.
- **Actions are CLI-only and key-gated.** The signing key is read from the **environment only** (`ROME_EVM_KEY`, and `ROME_SOLANA_KEY` for `verify`'s Solana lane) — **never** a flag, never logged, never sent through the MCP server. A missing key fails fast with a clear error before any network call.
- **The MCP server registers only `read` capabilities** (asserted by test) — so a key can never reach the MCP surface, and an agent given `rome mcp` cannot move funds no matter what it's asked.

Funded testing uses agent-generated wallets funded by the operator; keys live in a git-excluded location, never in the repo.

## Project layout

```
src/
  core/
    capabilities.ts   the single CAPABILITIES registry (both surfaces read this)
    facts.ts          chain/token/contract/gas/balance/programs + resolveChainId
    cookbook.ts       cpi-recipe + patterns + errors (the taxonomy) + curated index
    actions.ts        call (read) · deploy · send (viem + submitRomeTx)
    bridge.ts         fund · bridge in/out — the CCTP flow engines (orchestrate the SDK)
    activate.ts       one-time PDA funding for bridge-out (SimpleActivator) + the check
    new.ts            scaffold front door — wraps create-rome-app + chain pre-wiring
    doctor.ts         preflight checklist
    tx.ts             cross-VM diagnosis (rome_solanaTxForEvmTx; no debug_trace)
    verify.ts         the path-aware works-gate (+ probe.ts: bundled Store + CPI-Memo probes)
    presets.ts        foundry/hardhat config
    keys.ts           requireEvmKey / requireSolanaKey (env-only)
    eip1193.ts        Node EIP-1193 shim for submitRomeTx
    deps.ts           injectable RPC client (stubbed in tests)
  cli.ts              `rome <cmd>` dispatch + the --flag parser (exported main)
  mcp.ts              `rome mcp` — registers each READ capability as an MCP tool
  bin.ts              the `rome` binary entry
test/                 per-module unit tests + alignment + behavioral CLI (+ mcp-smoke.mjs e2e)
```

## Roadmap

Shipped: the full four-paths surface above (reads + actions), all funded-verified on a live Rome chain — including `verify --path solana-program` (an EVM-lane call driving a Solana program via CPI). Next: `verify --path from-home` · bridge ETH (Wormhole) · `new` (wraps `create-rome-app`). Shipped since: `bridge --to` (CCTP outbound, funded-verified) + `activate`. Deploy/build stays orchestrated (Foundry/Hardhat/create-rome-app) — `rome` is the connective tissue + the Rome-unique gaps, not a re-implementation of the EVM toolchain.
