# rome-cli — usage & integration guides

Concrete, copy-paste recipes: real commands with real output, and how to fold `rome` into an agent, a shell script, or CI. All output below is verbatim from Hadrian (200010).

- [Every command, with real output](#every-command-with-real-output)
- [Integrate into an AI agent (MCP)](#integrate-into-an-ai-agent-mcp)
- [The agent grounding loop](#the-agent-grounding-loop)
- [Fund a wallet from another chain (`fund` / `bridge`)](#fund-a-wallet-from-another-chain-fund--bridge)
- [Shell & scripting recipes](#shell--scripting-recipes)
- [Use it in CI](#use-it-in-ci)
- [End-to-end: build a price-reading contract, grounded by rome](#end-to-end-build-a-price-reading-contract-grounded-by-rome)

---

## Every command, with real output

### `rome facts chain <id>`
```console
$ rome facts chain hadrian
{
  "chainId": 200010,
  "name": "Rome Hadrian",
  "network": "devnet",
  "status": "live",
  "rpcUrl": "https://hadrian.testnet.romeprotocol.xyz/",
  "explorerUrl": "https://via-hadrian.testnet.romeprotocol.xyz/",
  "romeEvmProgramId": "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf",
  "nativeCurrency": { "name": "Rome Hadrian", "symbol": "USDC", "decimals": 18 },
  "solana": { "cluster": "devnet", "rpc": "https://api.devnet.solana.com" }
}
```
Resolves by id, name, or slug: `200010`, `hadrian`, `200010-hadrian`, `"Rome Hadrian"` all return the same chain. An unknown or ambiguous input fails loudly with the known set — it never guesses.

### `rome facts tokens <id>`
```console
$ rome facts tokens hadrian
{
  "chainId": 200010,
  "tokens": [
    { "address": "0xeeee…eeee", "mintId": "4zMMC9srt5Ri…DncDU", "symbol": "USDC",  "decimals": 18, "kind": "gas" },
    { "address": "0xd4cc34b6…ef28", "mintId": "4zMMC9srt5Ri…DncDU", "symbol": "wUSDC", "decimals": 6,  "kind": "spl_wrapper" },
    { "address": "0x8c2c1486…be7e", "mintId": "6F5YWWrUMNpe…ifWs", "symbol": "wETH",  "decimals": 8,  "kind": "spl_wrapper" },
    { "address": "0x1dece035…4201", "mintId": "So1111…1112",       "symbol": "wSOL",  "decimals": 9,  "kind": "spl_wrapper" }
  ],
  "note": "Token entries omit assetRef — match a wrapper to its underlying by shared mint (mintId); the gas token's wrapper shares its mint."
}
```
Note the gas token (`USDC`) and its wrapper (`wUSDC`) share a `mintId` — that's how you pair them (see the scripting recipe below).

### `rome facts gas <id>`
```console
$ rome facts gas hadrian
{
  "chainId": 200010,
  "gasPriceWei": "10403793960",
  "note": "eth_estimateGas can over-predict by a large factor; Rome charges the exact gas used… A plain native-token transfer costs ~1.48M gas (not 21k)."
}
```

### `rome facts contracts <id>` · `rome facts balance <id> <addr>` · `rome facts programs <network>`
```console
$ rome facts programs devnet
{
  "network": "devnet",
  "programs": {
    "splToken": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "wormholeCore": "3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5",
    "cctpTokenMessenger": "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
    …
  }
}
```

### `rome cookbook cpi-recipe [program]`
```console
$ rome cookbook cpi-recipe
{
  "precompiles": { "cpi": "0xff…08", "helper": "0xff…09", "withdraw": "0x42…16", "system": "0xff…07" },
  "accountRules": [
    "The accounts array must be non-empty.",
    "The operator and the program_id must NOT appear in the accounts array.",
    "To sign as your contract, pass HELPER.pda(address(this)) as the signer — the CPI precompile signs as msg.sender (the calling contract's PDA), not tx.origin, so a router cannot sign a user's PDA."
  ],
  "encoders": { "invoke": "encodeInvoke (from @rome-protocol/sdk)", "invokeSigned": "encodeInvokeSigned (from @rome-protocol/sdk)" }
}
```

### `rome cookbook patterns [goal]`
```console
$ rome cookbook patterns lending
[ { "goal": "Lending / borrow",
    "core": "a Solidity core; Solana users arrive via a synthetic sender",
    "repo": "aerarium",
    "guide": "developer-guides/dual-lane-app",
    "tags": ["lending","borrow","supply","money-market","compound","lend"] } ]
```
No goal → the full index (AMM → rome-dex, CPI → cardo, from-home → appia, oracle → rome-oracle-gateway, scaffold → create-rome-app).

---

## Integrate into an AI agent (MCP)

Give your coding agent grounded Rome facts so it stops guessing addresses and selectors.

**1. Install** (repo-first; npm publish pending):
```bash
npm install -g github:rome-protocol/rome-cli#v0.2.0
```

**2. Register the MCP server** in your client's config. You don't run or host anything — the client launches `rome mcp` on demand.

*Claude Code* (`~/.claude/settings.json` or project `.mcp.json`):
```json
{ "mcpServers": { "rome": { "command": "rome", "args": ["mcp"] } } }
```
*Claude Desktop / Cursor* — the same block in their MCP config.

**3. Verify** the tools are live:
```bash
rome mcp   # starts the stdio server; your client lists: facts_chain, facts_tokens,
           # facts_contracts, facts_gas, facts_balance, facts_programs,
           # cookbook_cpi_recipe, cookbook_patterns   (Ctrl-C to stop the manual check)
```

**4. Use it in a prompt.** Now the agent can call the tools instead of hallucinating:
> "Deploy my lending contract to Hadrian. Use `facts_chain` for the RPC + gas token, `facts_contracts` for the addresses, and `cookbook_cpi_recipe` if you touch a Solana program. Don't hardcode anything."

The agent calls `facts_chain(chain: "hadrian")`, gets the real RPC + `romeEvmProgramId`, and proceeds on facts.

---

## The agent grounding loop

The pattern that makes an agent reliable on Rome — **look up, then write**:

```
1. rome cookbook patterns <what I'm building>   → which example repo + architecture
2. rome facts chain <chain>                     → RPC, program id, gas token (no hardcoding)
3. rome facts contracts <chain>                 → the addresses I'll wire against
4. rome cookbook cpi-recipe                      → the CPI account-rules (if calling Solana)
5. …write the code against those exact values…
6. rome facts gas <chain>                        → sanity-check before sizing a tx
```

Concrete run for "I'm building a lending app":
```console
$ rome cookbook patterns lending    # → repo: aerarium, core: Solidity + synthetic sender
$ rome facts chain hadrian          # → rpcUrl, romeEvmProgramId, gas = USDC
$ rome facts tokens hadrian         # → wUSDC 0xd4cc34b6…, wETH, wSOL (the reserves)
```
The agent now writes against `aerarium`'s pattern with Hadrian's real RPC and the real wrapper addresses — nothing invented.

---

## Fund a wallet from another chain (`fund` / `bridge`)

The **from-home** path: you hold USDC on another chain and want onto Rome. `fund` bridges it in as **native gas**; `bridge --intent wrapper` brings it in as **wUSDC**. Both use Circle CCTP, orchestrated through [`@rome-protocol/sdk`](https://github.com/rome-protocol/rome-sdk-ts)'s `bridge` module — you sign only the source-chain burn; Rome's sponsor pays the settle.

These are **actions**: CLI-only, and they read `ROME_EVM_KEY` from the environment (never a flag, never logged, never on MCP).

**Preview first with `--dry-run`** — quotes the route and shows exactly what you'd sign, spending nothing:

```console
$ rome fund hadrian --from base-sepolia --amount 0.5 --dry-run
{
  "dryRun": true,
  "route": "usdc-cctp-to-rome",
  "amountIn": "500000",
  "amountOut": "500000",
  "fee": { "bps": 0, "absolute": "0", "asset": "USDC" },
  "etaSeconds": 1100,
  "plannedTxs": [
    { "stepN": 1, "to": "0x036CbD…dCF7e", "description": "Approve TokenMessenger to spend USDC" },
    { "stepN": 1, "to": "0x8FE6B9…2DAA", "description": "Burn USDC via CCTP, mintRecipient = user's Rome account" }
  ]
}
```

Drop `--dry-run` to execute: `rome` signs + broadcasts the two source txs, signs the trustless-settle authorization (gas intent only), registers the transfer, then polls to completion — printing the transfer id, outcome, and source tx hashes.

```bash
rome fund   hadrian --from base-sepolia --amount 0.5                    # → native gas on Rome
rome bridge hadrian --from base-sepolia --amount 0.5 --intent wrapper   # → wUSDC on Rome
```

Supported source chains come from the registry's bridge config for the target Rome chain — Base Sepolia, Arbitrum Sepolia, Polygon Amoy, Avalanche Fuji, Monad Testnet, Sepolia. Resolve a source by id, name, or slug (`84532`, `"base sepolia"`, `base-sepolia`). CCTP standard attestation takes ~15–20 min, so a real transfer isn't instant; the command polls until it lands.

> The bridge-api base defaults to the devnet orchestrator; override with `--bridge-api <url>` or `ROME_BRIDGE_API`.

---

## Shell & scripting recipes

`rome` prints JSON — pipe it to `jq`.

**Get a chain's RPC for a deploy script:**
```bash
RPC=$(rome facts chain hadrian | jq -r '.rpcUrl')
```

**Pair the gas token with its wrapper by shared mint** (the `assetRef` gotcha, solved):
```bash
GAS_MINT=$(rome facts tokens hadrian | jq -r '.tokens[] | select(.kind=="gas") | .mintId')
WUSDC=$(rome facts tokens hadrian | jq -r --arg m "$GAS_MINT" \
  '.tokens[] | select(.kind=="spl_wrapper" and .mintId==$m) | .address')
echo "$WUSDC"   # → 0xd4cc34b67c805d472b5a709a22a1037f6b16ef28
```

**Grab a Solana program id:**
```bash
rome facts programs devnet | jq -r '.programs.wormholeTokenBridge'
```

**Look up an EVM contract's live address before wiring it** (`contracts` is an array; each entry has versioned addresses):
```bash
# what's deployed:
rome facts contracts hadrian | jq -r '.contracts[].name'
# the live address of one contract:
rome facts contracts hadrian | jq -r \
  '.contracts[] | select(.name=="ERC20SPLFactory") | .versions[] | select(.status=="live") | .address'
# → 0x86149124d74ebb3aa41a19641b700e88202b6285
```

---

## Use it in CI

Fail a pipeline early if a fact drifts, instead of debugging a broken deploy later.

**Assert the chain is live before deploying:**
```bash
STATUS=$(rome facts chain "$CHAIN" | jq -r '.status')
[ "$STATUS" = "live" ] || { echo "::error::$CHAIN is not live ($STATUS)"; exit 1; }
```

**Pin an expected address (catch registry drift):**
```bash
GOT=$(rome facts tokens hadrian | jq -r '.tokens[] | select(.symbol=="wUSDC") | .address')
[ "$GOT" = "$EXPECTED_WUSDC" ] || { echo "::error::wUSDC moved: $GOT"; exit 1; }
```

**Emit the RPC into the build env:**
```bash
echo "ROME_RPC=$(rome facts chain "$CHAIN" | jq -r '.rpcUrl')" >> "$GITHUB_ENV"
```

`rome` is read-only and needs no keys, so it's safe in any CI step.

---

## End-to-end: build a price-reading contract, grounded by rome

You want a Solidity contract that reads a price feed. Let `rome` route and ground you:

```console
$ rome cookbook patterns oracle
[ { "goal": "Price feeds in a contract",
    "core": "Chainlink AggregatorV3Interface over Pyth / Switchboard",
    "repo": "rome-oracle-gateway",
    "guide": "products/oracle-gateway" } ]
```
→ Read [rome-oracle-gateway](https://github.com/rome-protocol/rome-oracle-gateway); the feeds are behind the standard Chainlink `AggregatorV3Interface`.

```console
$ rome facts contracts hadrian | jq -r '.contracts[].name'   # what's deployed to wire against
$ rome facts chain hadrian | jq -r '.rpcUrl'                 # the RPC your deploy script points at
```

Now your contract imports `IAggregatorV3Interface` from `@rome-protocol/rome-solidity`, wires the feed address from `rome facts contracts`, deploys against the RPC from `rome facts chain`, and you sized nothing off a guess. When you add a write path, use [`@rome-protocol/sdk`](https://github.com/rome-protocol/rome-sdk-ts)'s `submitRomeTx` (the CLI stays read-only).

---

See also: [`README.md`](../README.md) for the quick start, and [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for how it's built and the security model.
