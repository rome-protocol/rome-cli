# rome — the Rome Protocol dev CLI + MCP server

`rome` gives a builder — human or AI agent — **grounded chain facts** and the **right build pattern** for Rome Protocol, through two aligned surfaces over one core:

- **`rome <group> <command>`** — a CLI for humans and agent shell-outs.
- **`rome mcp`** — the same capabilities as an [MCP](https://modelcontextprotocol.io) server for MCP-native agents.

Both surfaces expose the **same** capabilities with the same names — an agent learns one mental model, and nothing drifts because there is one implementation.

Two things stall an agent building on Rome: **hallucinated facts** (wrong ids, addresses, selectors) and **not knowing the pattern** (how to CPI, which example to copy). `rome` answers both, read-only, from the live registry and the SDK.

**Docs:** [`docs/GUIDES.md`](docs/GUIDES.md) — real usage + how to fold it into an agent, a shell script, or CI · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how it's built, every capability, the security model, and CLI-vs-MCP.

## Install

Repo-first (npm publish pending):

```bash
npm install -g github:rome-protocol/rome-cli#v0.8.0
# or run without installing:
npx github:rome-protocol/rome-cli#v0.8.0 facts chain hadrian
```

## CLI

```bash
rome facts chain hadrian           # chain id, RPC, explorer, program id, gas token
rome facts tokens 200010           # token list (address, mint, symbol, decimals)
rome facts contracts hadrian       # deployed contract addresses
rome facts gas hadrian             # current gas price + the estimate-vs-charge caveat
rome facts balance hadrian 0x…     # native (gas-token) balance for an address
rome facts programs devnet         # Solana program ids for a network
rome cookbook cpi-recipe           # the CPI account-rules + SDK encoders (grounded addresses)
rome cookbook patterns lending     # which example repo + guide fits a goal
rome cookbook errors "Custom(1)"   # decode a Rome failure → cause + fix (the error taxonomy)
rome preset foundry hadrian        # ready Rome network config for foundry / hardhat + the quirks
rome call hadrian 0x… "balanceOf(address) returns (uint256)" 0x…   # read a contract (no key)
rome doctor hadrian --address 0x…  # preflight: chain live? RPC reachable? program set? wallet funded?
rome tx hadrian 0x…                # diagnose a tx: EVM receipt + the Solana settlement tx(s) + a Via link

# actions — sign on-chain, need ROME_EVM_KEY (never a flag/log/MCP):
rome deploy hadrian ./out/Store.json                # deploy a compiled artifact
rome send   hadrian 0x… "set(uint256)" 42           # write via submitRomeTx
rome fund   hadrian --from base-sepolia --amount 1  # bridge USDC → Rome gas (CCTP, "from home")
rome bridge hadrian --from base-sepolia --amount 1 --intent wrapper   # USDC → wUSDC on Rome
rome verify hadrian --path solidity   # both-lane works-gate (needs ROME_EVM_KEY + ROME_SOLANA_KEY)
```

Chains resolve by id, name, or slug (`200010`, `hadrian`, `200010-hadrian`). Output is JSON — pipe it to `jq` or read it in an agent:

```console
$ rome facts chain hadrian
{
  "chainId": 200010,
  "name": "Rome Hadrian",
  "rpcUrl": "https://hadrian.testnet.romeprotocol.xyz/",
  "romeEvmProgramId": "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf",
  "nativeCurrency": { "symbol": "USDC", "decimals": 18 }, …
}

# pair the gas token with its wrapper by shared mint, in one line:
$ rome facts tokens hadrian | jq -r '.tokens[] | select(.symbol=="wUSDC") | .address'
0xd4cc34b67c805d472b5a709a22a1037f6b16ef28
```

More recipes — agent (MCP), shell, and CI integration — in [`docs/GUIDES.md`](docs/GUIDES.md).

## MCP server

**You don't run or host anything.** `rome mcp` is a **stdio** server (not a network daemon) that your MCP client launches for you. Register it once:

```json
{
  "mcpServers": {
    "rome": { "command": "rome", "args": ["mcp"] }
  }
}
```

The client (Claude Code / Claude Desktop / Cursor / …) spawns `rome mcp` as a child process on demand, talks to it over stdin/stdout, and shuts it down when the session ends — no port, no hosting, no process manager. It exposes each capability as a tool (`facts_chain`, `facts_gas`, `cookbook_cpi_recipe`, …), is **read-only and holds no keys** — safe to wire into any agent; it can never sign a transaction or leak a secret. Your app always does the signing, via [`@rome-protocol/sdk`](https://github.com/rome-protocol/rome-sdk-ts). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#running-it--cli-vs-mcp-server) for the lifecycle.

## What it is — two layers

- **Grounding — read-only, on both CLI + MCP**: `facts` + `cookbook` + `call`. Kills hallucination, routes you to the right pattern, reads contracts. Holds no keys — safe to wire into any agent.
- **Actions — CLI-only, key-gated, never on MCP**: `deploy` / `send` (contracts) and `fund` / `bridge` (the "from home" on-ramp: bridge USDC in as gas or wUSDC via CCTP). These sign, so they read the key from the environment (`ROME_EVM_KEY`) — never a flag, never logged, never through the MCP server. Every action prints what it did; funding previews with `--dry-run`.
- Everything is sourced from [`@rome-protocol/registry`](https://github.com/rome-protocol/rome-registry) + the chain's RPC + the SDK's `@rome-protocol/sdk/bridge` — nothing chain-specific is hardcoded.
- Still orchestrates, doesn't replace: heavy contract builds stay in Foundry / Hardhat; scaffolding is [`create-rome-app`](https://github.com/rome-protocol/create-rome-app); library writes use [`@rome-protocol/sdk`](https://github.com/rome-protocol/rome-sdk-ts).

## Development

```bash
npm install
npm run build
npm test                     # unit tests, incl. the CLI↔MCP alignment invariant
node scripts/mcp-smoke.mjs   # end-to-end: a real MCP client drives `rome mcp` over stdio
```

## License

MIT — see [LICENSE](LICENSE).
