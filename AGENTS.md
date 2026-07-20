<!--
CANONICAL AGENTS.md (v3.1). Ships in every public Rome repo + the create-rome-app
scaffold. Public-safe: no internal hostnames, infra/platform names, or internal
repo paths. Links marked (docs) resolve once the docs site publishes; npm packages
resolve at their publish. Organized by where the builder starts — the depth lives
in the docs + the example repos it points to. Keep it short; an agent reads it
before writing a line.
-->
# AGENTS.md — building on Rome with an AI coding agent

**Rome is EVM chains that run natively inside the Solana runtime.** Your Solidity/EVM app executes inside a Solana program and can call Solana programs atomically (CPI). Two lanes reach the same chain and the same state: MetaMask/EVM tooling, and Phantom/Solana.

This file gives you the facts, organized by **what you're starting from**. Find your starting point, apply the rules that bite on every path, and read the example repo closest to what you're building. Vanilla-EVM habits produce plausible-but-wrong code here — reads (`eth_call`, balances, logs) are standard; the differences are in writes, gas, tooling, CPI, and architecture.

## First, the mental model — three facts everything rests on
- **EVM inside Solana.** Your Solidity runs inside a Solana program; from Solidity you can invoke *any* Solana program (SPL Token, Meteora, a program you wrote) atomically, in one transaction, via the CPI precompile.
- **One state, two lanes.** MetaMask (an EVM key) and Phantom (a Solana key) drive the **same** contracts and the **same** state. A Phantom user signs with their **Solana** key — no EVM keypair, no separate address. An EVM user's on-chain identity is a Rome-derived PDA (`external_auth`).
- **SPL *is* ERC-20, automatically.** Any SPL token is already an ERC-20 on Rome — the **same account**, no bridge and no wrapped-asset hop. An LP or position token minted as an SPL mint is immediately spendable as an ERC-20, and vice-versa.

## Find your starting point

### You have Solidity — a contract, or an EVM app to fork
Deploy it as it is, with standard Hardhat or Foundry (one caveat: `forge script` needs `--skip-simulation`; `forge create`, `cast`, and Hardhat work normally). The same contract serves EVM (MetaMask) and Solana (Phantom) users — you don't write per-audience code, and nothing about your Solidity changes. When you want Solana liquidity or data, call a Solana program via CPI (see the rules below).
**Read:** [compound-on-rome-comet](https://github.com/rome-protocol/compound-on-rome-comet) and [rome-aave-v3](https://github.com/rome-protocol/rome-aave-v3) — Compound v3 and Aave v3 running unchanged.

### You have a Solana program
It keeps doing what it already does for your Solana users — no changes. To open it to EVM (and other-chain) users, write a **thin Solidity wrapper that CPIs your program**: the accounts array and instruction data are the same layout your program already expects. Make your instructions **authority-agnostic** — act on whichever authority signs — so the caller can be a Solana wallet pubkey *or* an EVM user's `external_auth` PDA. The precompile signs as `msg.sender` (the wrapper's own PDA), not `tx.origin`.
**Read:** [cardo](https://github.com/rome-protocol/cardo) — drives Jupiter, Meteora, Marinade, and Mango from an EVM account.

### You have one lane and want to open the other — the Parity Pattern
Keep **one** source of truth, written authority-agnostic, and open the other lane to it. This comes in **both** shapes (see *Which side is your core?* below): a **native Solana program + thin EVM router**, or a **Solidity core that Solana users reach via a synthetic sender**. Either way a Phantom user and a MetaMask user act on the **same reserves/state** — Rome auto-signs the EVM user's PDA. Because the LP/position token is an SPL mint, it's automatically an ERC-20, so a position opened on one lane is spendable on the other. Keep the account set lean and ALT-friendly to keep the EVM lane cheap, and test both lanes.
**Read:** [rome-dex](https://github.com/rome-protocol/rome-dex) (AMM — native core + router) and [aerarium](https://github.com/rome-protocol/aerarium) (lending — Solidity core + synthetic sender).

### You're building greenfield — bring your idea
Use both sides from day one: one pool both audiences trade, one market both borrow from, an oracle that brings Solana prices into the EVM. Decide the architecture up front — see *Which side is your core?* below. Resolve everything from the registry; use the SDK for writes.
**Read:** [rome-dex](https://github.com/rome-protocol/rome-dex), [appia](https://github.com/rome-protocol/appia), [rome-oracle-gateway](https://github.com/rome-protocol/rome-oracle-gateway). **Scaffold:** `create-rome-app` (ships with the docs release).

### Your users are on their home turf — reach Rome from another chain
Your users don't move — from their home chain (an L2, Solana, …) they reach your Rome app without leaving. The bridge is **on-chain**: `RomeBridgeWithdraw` (egress from Rome) + the rome-evm `settle_inbound_bridge` program (inbound credit, authorized by the user's own signed **EIP-712** intent). Transport is Circle CCTP (USDC) or Wormhole. The off-chain **`rome-bridge-api`** orchestrates it: quote a route → verify the source tx → sponsor the settle fee.
**Read:** [appia](https://github.com/rome-protocol/appia) (a from-home app), [rome-bridge-api](https://github.com/rome-protocol/rome-bridge-api) (the orchestrator; see its `docs/BRIDGE_API_ARCHITECTURE.md`).

## Which side is your core?
Which side holds the core logic is a **soft, per-app judgment** — weigh existing code/assets, team expertise, security posture, tooling, performance, and how each audience uses it. There's no hard rule.
- **(a) Solidity core; Solana users arrive via a synthetic sender.** Often fits a Solidity contract you already have (especially hardened/audited), standard EVM tooling, or straightforward logic. A Phantom user's Solana signature runs as an EVM tx from their Rome-derived PDA — no EVM key. *Example: [aerarium](https://github.com/rome-protocol/aerarium).*
- **(b) Native Solana program core; EVM users arrive via a thin CPI router.** Often fits an existing Solana program, or when running the core natively matters. *Example: [rome-dex](https://github.com/rome-protocol/rome-dex).*

For example, performance might tip it: native can be much cheaper than the EVM interpreter for heavy logic (one swap we measured ran ~6× cheaper) — consider it if you have a hot compute-heavy path. It's one input, not a rule.

## Getting funded — USDC is the gas token; bridge it in
Every Rome chain's gas token is **USDC** (Circle). **There is no Rome faucet.** Fund a wallet by **bridging USDC into Rome** from a chain where you already have it: get testnet USDC on a source chain (Sepolia, an L2, or Solana) from *that chain's* own faucet, then bridge to Hadrian/Martius (the on-chain `settle_inbound_bridge`, orchestrated by `rome-bridge-api`; CCTP for USDC).

## The rules that bite on every path (different from vanilla EVM)

1. **Every write goes through the SDK.** On the EVM lane use `submitRomeTx` (not raw `wagmi`/`ethers`/`viem` `writeContract`/`sendTransaction` — Rome writes have specific fee + submission semantics). On the **Solana lane** (a Solana wallet driving your EVM app) use `submitRomeTxSolanaLane`. Reads stay vanilla.
2. **Gas: the estimate over-predicts; the charge is exact.** `eth_estimateGas` can over-predict by a large factor — Rome charges the exact gas used, so don't hard-fail or size budgets off a high estimate. A plain native-token transfer costs **~1.48M gas** (not 21k); budget for it in scripts and sweeps.
3. **Calling Solana from Solidity (CPI — the differentiator).** Precompiles: **CPI `0xFF…08`**, **Helper `0xFF…09`**, **Withdraw `0x42…16`**. The account rules agents get wrong: the accounts array must be **non-empty**; the **operator and the program_id must NOT** appear in it; to sign as your contract use `HELPER.pda(address(this))` as the signer (the precompile signs as `msg.sender`, so a router contract cannot sign a *user's* PDA). Full ABI + per-selector billing: the precompile reference (docs).
4. **Never hardcode addresses — read the registry.** Chain ids, RPC URLs, contract addresses, token mints, and Solana program ids all come from **`@rome-protocol/registry`** (or the `rome-mcp` `getChain`/`getTokens`/`getContracts` tools). Hardcoded values drift and break across deploys.
5. **Test both lanes with a fresh wallet.** A feature must work on the EVM lane (MetaMask) *and* the Solana lane (Phantom). Verify each with a brand-new wallet and a tiny amount before claiming done.
6. **When a tx fails, use the taxonomy + the cross-VM map.** Rome surfaces specific failures (rent-starved pool payer or StateHolder, emulation-vs-simulation mismatches, nonce races). Match them against the error taxonomy (docs). To see the Solana settlement of a Rome tx, map it with `solanaTxForEvmTx`.

## The SDK — `@rome-protocol/sdk`
The TypeScript SDK ([`rome-sdk-ts`](https://github.com/rome-protocol/rome-sdk-ts)) is your write path and your CPI toolkit: `submitRomeTx` + fee sizing, PDA/ATA derivation, CPI `invoke`/`invoke_signed` encoders, precompile bindings, and a `/bridge` module. For the **Solana lane**, `submitRomeTxSolanaLane` mirrors `submitRomeTx` (a Solana wallet drives your EVM app; `buildFundLeg`/`buildSweepLeg` move value in/out — the synthetic holds nothing at rest). Use it for every write and every Solana-from-Solidity call rather than hand-rolling calldata.

## Live facts for your agent
Live chain facts (ids, RPC, addresses, mints, program ids) come from **`@rome-protocol/registry`** (see rule 4). A read-only **`rome-mcp`** server — registry / balance / gas / bridge-quote, no keys, no faucet — is coming with the docs release; until then, read the registry directly. Your app always does the signing, via the SDK.

## Verify before you claim done
Before saying a change works: check RPC config, confirm every write goes through `submitRomeTx`, and run a **both-lane smoke** against devnet with a fresh wallet and a tiny amount (fund → deploy → act → assert on each lane). A scaffold + one-command self-check are coming with the docs release.
