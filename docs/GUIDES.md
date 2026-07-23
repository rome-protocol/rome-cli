# rome-cli — usage & integration guides

Concrete, copy-paste recipes: real commands with real output, and how to fold `rome` into an agent, a shell script, or CI. All output below is verbatim from Hadrian (200010).

- [Every command, with real output](#every-command-with-real-output)
- [Integrate into an AI agent (MCP)](#integrate-into-an-ai-agent-mcp)
- [The agent grounding loop](#the-agent-grounding-loop)
- [Start an app (`rome new`)](#start-an-app-rome-new)
- [Fund a wallet from another chain (`fund` / `bridge`)](#fund-a-wallet-from-another-chain-fund--bridge)
- [Bridge out of Rome (`bridge --to`) + `activate`](#bridge-out-of-rome-bridge---to--activate)
- [Prove it works — `rome verify`](#prove-it-works--rome-verify)
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

### `rome cookbook errors [query]`
```console
$ rome cookbook errors gas
[ { "symptom": "eth_estimateGas returns a huge value (often 10-50× the real charge)…",
    "cause": "Rome charges the EXACT gas used; the estimate is a loose upper bound.",
    "fix": "Don't hard-fail or size budgets off the estimate. A native transfer is ~1.48M gas, not 21k." } ]
```
No query → the full taxonomy (`Custom(0)`/AccountLocked, `CpiProhibitedInIterativeTx`, `UnknownInstruction(N)`, `forge --skip-simulation`, Solana-lane `Custom(1)`, …).

### `rome doctor <chain> [--address 0x…]`
```console
$ rome doctor hadrian --address 0x1Fc3…
{
  "chain": { "id": 200010, "name": "Rome Hadrian", "network": "devnet", "status": "live" },
  "checks": [
    { "name": "chain-live",         "ok": true, "detail": "status=live" },
    { "name": "program-configured", "ok": true, "detail": "RPTWwELX…" },
    { "name": "rpc-reachable",      "ok": true, "detail": "https://hadrian…/ (gasPrice …)" },
    { "name": "wallet-funded",      "ok": true, "detail": "… wei (USDC)" }
  ],
  "ok": true
}
```

### `rome tx <chain> <hash>`
```console
$ rome tx hadrian 0x8d99…
{
  "status": "success",
  "receipt": { "gasUsed": "0x1607b0", "from": "0x…", "to": "0x…", "blockNumber": "0x…" },
  "solanaSettlement": ["5Lwke7W1…"],
  "explorer": "https://via-hadrian.testnet.romeprotocol.xyz/tx/0x8d99…",
  "note": "Confirmed. solanaSettlement lists the Solana tx(s) that settled this EVM tx."
}
```
Rome has no `debug_trace*`; `tx` maps the EVM hash to its Solana settlement via `rome_solanaTxForEvmTx`.

### `rome preset <foundry|hardhat> <chain>`
```console
$ rome preset foundry hadrian
{
  "tool": "foundry", "chainId": 200010, "filename": "foundry.toml",
  "config": "[rpc_endpoints]\nrome-hadrian = \"https://hadrian.testnet.romeprotocol.xyz/\"",
  "notes": ["forge script --skip-simulation …", "Rome charges exact gas; estimateGas over-predicts …", "…"]
}
```

---

## Integrate into an AI agent (MCP)

Give your coding agent grounded Rome facts so it stops guessing addresses and selectors.

**1. Install** (repo-first; npm publish pending):
```bash
npm install -g github:rome-protocol/rome-cli#v0.9.0
```

**2. Register the MCP server** in your client's config. You don't run or host anything — the client launches `rome mcp` on demand.

*Claude Code* (`~/.claude/settings.json` or project `.mcp.json`):
```json
{ "mcpServers": { "rome": { "command": "rome", "args": ["mcp"] } } }
```
*Claude Desktop / Cursor* — the same block in their MCP config.

**3. Verify** the tools are live:
```bash
rome mcp   # starts the stdio server; your client lists the READ tools: facts_chain,
           # facts_tokens, facts_contracts, facts_gas, facts_balance, facts_programs,
           # cookbook_cpi_recipe, cookbook_patterns, cookbook_errors, call, doctor, tx, preset
           # (actions — new/deploy/send/fund/bridge/activate/verify — are CLI-only, never on MCP)
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

## Start an app (`rome new`)

The scaffold front door. Wraps [`create-rome-app`](https://github.com/rome-protocol/create-rome-app) (the canonical dual-lane scaffolder — a Vault contract + both lanes + a Vite UI), then adds what the scaffolder can't know: your **chain**, resolved from the registry and pre-wired into the app's `.env`. Keyless — it signs nothing (the key stays out until you fund/deploy).

```console
$ rome new my-app --chain hadrian
{
  "app": "my-app",
  "chainId": 200010,
  "chainName": "Rome Hadrian",
  "next": [
    "cd my-app && npm install",
    "# fund the wallets in .env (gas is USDC — bridge it in; no faucet):",
    "rome fund hadrian --from base-sepolia --amount 1",
    "npm run deploy      # deploy the Vault to Rome Hadrian",
    "npm run demo        # the funded dual-lane proof (MetaMask + Phantom → one Vault)",
    "rome verify hadrian   # the works-gate, any path"
  ]
}
```

The `next` steps are the whole lifecycle in this CLI's own commands — scaffold → fund → deploy → prove. Templates live in `create-rome-app` (today: the dual-lane Vault, i.e. the *bring-your-idea* path); as per-path templates land there, `new` grows matching flags.

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

**Holding ETH instead?** Add `--asset eth` — it rides **Wormhole** and lands as **wETH** on Rome (never gas; gas is USDC, so `--intent` doesn't apply):

```bash
rome bridge hadrian --from sepolia --amount 0.002 --asset eth   # ETH → wETH on Rome (~15 min VAA)
```

You sign one wrap-and-transfer tx on the source; Rome's sponsor completes the transfer on the Solana side once the VAA is ready.

> The bridge-api base defaults to the devnet orchestrator; override with `--bridge-api <url>` or `ROME_BRIDGE_API`.

---

## Bridge out of Rome (`bridge --to`) + `activate`

The reverse of `fund` / `bridge --from`: you hold **wUSDC** on Rome and want USDC back on another chain. `bridge --to <dest>` burns your wUSDC on Rome via `RomeBridgeWithdraw` (CCTP v2) and hands you a **claim handle** for the destination. `--from` = in, `--to` = out (exactly one; `fund` is always in).

**The responsibility splits by chain — this is the design, not a limitation:**
- **Rome side — orchestrated for you.** You sign one burn tx; the engine registers the transfer and polls until Circle attestation is ready. (Rome runs a sponsor for the *inbound* settle intent; outbound carries no settle.)
- **Destination side — yours.** Rome does **not** sponsor the destination mint. You call `MessageTransmitterV2.receiveMessage(message, attestation)` on the destination — which needs gas **on that chain**. The command returns the transmitter, the CCTP domain, and the transfer id so you (or Circle's portal / the bridge-api) can complete it. Delivery is permissionless (`destinationCaller = 0`), so anyone can submit it.

### First time out: activate once (`rome activate`)

Inbound is deliberately frictionless — no per-user account is needed. The **first time you bridge out**, CCTP's `deposit_for_burn` creates a per-burn `messageSentEventData` account funded by your **external-auth PDA**, so that PDA must hold lamports (~15M reserve per burn). `rome activate <chain>` funds it once (~2 USDC, via the on-chain `SimpleActivator`); it's **idempotent** — it skips with no spend if you're already activated. `bridge --to` checks this first (a pure EVM read of the PDA lamports via the `account_lamports` precompile) and points you here rather than letting the burn revert deep inside CCTP.

```console
$ rome activate hadrian
{ "address": "0x1Fc3…", "pda": "BTbRPi8n…", "alreadyActivated": true, "lamports": "26099680" }
```

### Bridge out

```console
$ rome bridge hadrian --to base-sepolia --amount 0.1 --dry-run   # quote + planned burn, no spend
$ rome bridge hadrian --to base-sepolia --amount 0.1
{
  "route": "usdc-cctp-from-rome",
  "burnTxHash": "0xc4549892…",
  "destinationChainId": 84532,
  "claim": {
    "yourResponsibility": true,
    "status": "ready",
    "transmitter": "0xE737…E275",
    "domain": 6,
    "note": "Claiming on Base Sepolia … call MessageTransmitterV2.receiveMessage(message, attestation) … (needs gas on Base Sepolia). The bridge-api tracks this transfer at id=txf_…"
  }
}
```

Destinations are the same registry CCTP chains as sources (resolve by id / name / slug). `--recipient` sets the destination address (default = your address).

**ETH out:** `--asset eth` burns your **wETH** on Rome (two txs: approve + burn) and exits via **Wormhole to Ethereum only** (`--to sepolia`; the CLI refuses any other destination). Same claims-are-yours rule — redeem the VAA on Ethereum when it's ready, and guard with `isTransferCompleted`: re-redeeming an already-completed VAA reverts with a misleading gas error. First outbound still needs `rome activate`.

### How the bridge actually works

- **The real bridge is on-chain.** `RomeBridgeWithdraw.burnUSDC` (egress) + Circle CCTP v2 do the work. The **bridge-api** ([`rome-protocol/rome-bridge-api`](https://github.com/rome-protocol/rome-bridge-api)) is an off-chain *orchestrator + tracker* — it quotes the route and follows the transfer; it **holds no funds and cannot move yours**.
- **Inbound** (`--from`): burn on the source L2 → Circle attestation → Rome's sponsor settles on Rome. You sign only the source burn; no activation needed.
- **Outbound** (`--to`): activate (first time) → burn wUSDC on Rome → Circle attestation → **you** claim on the destination. No settle authorization, no destination sponsor.
- Base override for the orchestrator: `--bridge-api <url>` or `ROME_BRIDGE_API` (defaults to the devnet orchestrator).

## Prove it works — `rome verify`

The keystone: prove a contract actually works on Rome, driven from **both lanes**. `verify --path solidity` deploys a probe, sets a value from the EVM lane (`submitRomeTx`) *and* the Solana lane (`submitRomeTxSolanaLane`), and asserts the same contract answered on each — the litmus test, runnable.

A funded **action**: needs `ROME_EVM_KEY` + `ROME_SOLANA_KEY` (env-only), CLI-only, never on MCP.

```console
$ rome verify hadrian --path solidity
{
  "path": "solidity",
  "probe": "0x368744e9…",
  "checks": [
    { "lane": "evm",    "wrote": "42", "read": "42", "ok": true },
    { "lane": "solana", "wrote": "43", "read": "43", "ok": true }
  ],
  "ok": true
}
```

`ok: true` means one contract on Rome answered correctly whether an EVM wallet *or* a Solana wallet drove it — the dual-lane promise, verified on-chain.

### `--path solana-program` — an EVM user drives your Solana program via CPI

Brought a **Solana program**? The gate is different: prove an EVM-lane call reaches it through the CPI precompile. `verify --path solana-program` deploys a thin CPI wrapper (its constructor self-provisions the contract's external-auth PDA), then an EVM-lane `ping` drives the SPL Memo program via CPI. A successful EVM receipt is the proof — a failed CPI reverts the tx. This path needs **only `ROME_EVM_KEY`** (no Solana key — the EVM lane is the whole story).

```console
$ rome verify hadrian --path solana-program
{
  "path": "solana-program",
  "probe": "0x206d7101…",
  "program": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "evmTx": "0x82aae391…",
  "cpiLanded": true,
  "ok": true
}
```

Add `--solana-rpc <url>` for the deep check: `verify` resolves the EVM tx to its Solana settlement (`rome_solanaTxForEvmTx`) and confirms the memo landed in the program's logs (`"memoConfirmed": true`).

### `--path from-home` — the round trip, proven

Coming **from another chain**? This gate proves the whole journey: USDC bridges **in** (as wUSDC), **works** on Rome, and bridges back **out**.

```console
$ rome verify hadrian --path from-home --from sepolia --amount 0.2
{
  "path": "from-home",
  "legs": {
    "in":  { "ok": true, "txHash": "0x…", "landed": true, "wusdcDelta": "200000" },
    "act": { "ok": true, "hash": "0x…" },
    "out": { "ok": true, "burnTxHash": "0x…", "claimReady": true }
  },
  "ok": true
}
```

Three legs, in order, failing fast: **in** (CCTP wrapper intent — waits through Circle attestation, ~15–20 min, and asserts the wUSDC actually landed) → **act** (a real wUSDC transfer via `submitRomeTx` — the asset is usable on Rome) → **out** (`bridge --to` back to the source chain, asserted to attestation-ready + a claim handle). The destination claim is your step, as always. Prereqs (checked up front with clear errors): `ROME_EVM_KEY`; USDC + gas on the source chain; gas on Rome; **an activated account** (`rome activate` — the out-leg burns).

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
