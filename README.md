# rome — the Rome Protocol dev CLI + MCP server

`rome` gives a builder — human or AI agent — **grounded chain facts** and the **right build pattern** for Rome Protocol, through two aligned surfaces over one core:

- **`rome <group> <command>`** — a CLI for humans and agent shell-outs.
- **`rome mcp`** — the same capabilities as an [MCP](https://modelcontextprotocol.io) server for MCP-native agents.

Both surfaces expose the **same** capabilities with the same names — an agent learns one mental model, and nothing drifts because there is one implementation.

Two things stall an agent building on Rome: **hallucinated facts** (wrong ids, addresses, selectors) and **not knowing the pattern** (how to CPI, which example to copy). `rome` answers both, read-only, from the live registry and the SDK.

## Install

Repo-first (npm publish pending):

```bash
npm install -g github:rome-protocol/rome-cli
# or run without installing:
npx github:rome-protocol/rome-cli facts chain hadrian
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
```

Chains resolve by id, name, or slug (`200010`, `hadrian`, `200010-hadrian`). Output is JSON — pipe it to `jq` or read it in an agent.

## MCP server

Add to your MCP client (e.g. Claude Code / Claude Desktop) config:

```json
{
  "mcpServers": {
    "rome": { "command": "rome", "args": ["mcp"] }
  }
}
```

The server exposes each capability as a tool (`facts_chain`, `facts_gas`, `cookbook_cpi_recipe`, …). It is **read-only and holds no keys** — safe to wire into any agent; it can never sign a transaction or leak a secret. Your app always does the signing, via [`@rome-protocol/sdk`](https://github.com/rome-protocol/rome-sdk-ts).

## What it is — and isn't (v1)

- **v1 is grounding**: facts + cookbook, read-only. It kills hallucination and points at the right pattern.
- It does **not** deploy or sign. Deploy with Foundry / Hardhat or [`create-rome-app`](https://github.com/rome-protocol/create-rome-app); write from your app via the SDK.
- Facts come from [`@rome-protocol/registry`](https://github.com/rome-protocol/rome-registry) and the chain's RPC; the CPI recipe's precompile addresses come from the SDK — nothing is hardcoded here.

## Development

```bash
npm install
npm run build
npm test                     # unit tests, incl. the CLI↔MCP alignment invariant
node scripts/mcp-smoke.mjs   # end-to-end: a real MCP client drives `rome mcp` over stdio
```

## License

MIT — see [LICENSE](LICENSE).
