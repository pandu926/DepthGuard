# Depthguard economy contracts

Three Anchor programs extend native Meteora launches with immutable model attribution,
post-graduation milestone funding and reserve-backed burn redemption. DBC performs price
discovery and graduation. DAMM v2 runs the destination market. Native Dynamic Fee Sharing
(DFS) receives trading fees; project and reserve capital never enter the royalty ledger.

Local compiled-SBF acceptance and a genuine Agave RPC lifecycle remain the baseline.
The React/Vite consumer app uses the Rust API and these contracts. Isolated official
Solana devnet deployment and acceptance are documented in [DEVNET.md](../docs/DEVNET.md),
with public release and lifecycle evidence recorded separately from local tests.
Mainnet broadcast remains blocked pending production acceptance and independent review.

## Programs and immutable terms

| Program | Responsibilities | Configured localnet / devnet ID |
|---|---|---|
| Registry | Staged model publication, official fork attribution, factory CPIs, migration verification and capital activation | `5sUGNQ5pymevqfVmg99rgQ2jM4aVSo6RqhJtSK7VrPYz` |
| Escrow | Majority milestone review, fixed deadlines, remaining-capital burn refunds | `8zEaBFNNVDx9U4Cr111xfZjUmX7JMBapJhd6yT4XwtuZ` |
| Reserve | Donations and atomic pro-rata burn redemption | `7kaGXYpxPuCoh5o2AhxRoU8F13UUkHjfxVZUTYsKG88Y` |

The local profile accepts standard SPL base tokens, immutable mint/freeze authorities and
WSOL quotes. Token-2022 quote hooks, external issuer adapters and real xStock launches are
outside this release. The four mechanism tags are meme, funding, backed and asset quote;
the asset-quote tag currently uses the same supported WSOL execution profile. Earlier
non-SOL native pilots remain separate evidence, not acceptance for these modules.

DBC configuration terms allow 1–16 curve segments, base decimals 6–9, fixed token supply,
positive graduation threshold, 25–1,000 bps trading fees and 0–10,000 bps compounding.
The destination uses custom DAMM fees, quote fees for zero compounding and native
compounding mode otherwise. All partner LP is permanently locked and owned through DFS.
Funding/backed terms require a positive native migration allocation (1–99%), with 100%
of that allocation assigned to the launch PDA's creator share. Trading-only mechanisms
have no capital allocation. These allocations reduce liquidity delivered to DAMM.

`ModelSpec` is a typed executable Borsh commitment. Its digest binds a domain separator,
publisher, parent, original author and exact executable bytes. Publication stores an
additional canonical-JSON hash. The Rust encoder computes both; the program verifies the
executable preimage, not the canonical JSON preimage. Never treat an arbitrary directly
submitted JSON hash as proof that displayed JSON equals executable terms.

Publication stages at most 8 KiB, in sequential chunks of at most 600 bytes. The supplied
native configuration is bounded to 4 KiB. A sealed model cannot be changed. Official
forks must retain their parent's original author and fee shares; separate independent
program deployments can bypass platform royalties. Default shares are 80/10/10 and
native DFS merges recipients when launcher and author are the same wallet.

## Lifecycle and rights

`declared (0) -> config (1) -> trading (2) -> migration verified (3) -> funded (4)`.

The launch PDA is the native DBC creator. Only the launcher can create its config, pool
and module. Native migration, verification and the final funding call can be permissionless.
Migration verifies native owners/layouts, the pair/config-derived DAMM pool, permanent LP
lock and its canonical DFS-owned position NFT. Native migration may choose a different
fresh NFT mint than the launcher anticipated; verification records the actual mint.
Module initialization is allowed in phases 2 and 3, so an early migration cannot strand it.

Funding atomically withdraws the native creator migration allocation straight into the
canonical module ATA, verifies a positive balance increase and activates the module.
A failed activation rolls back the withdrawal. There is no refund or redemption right
before verified migration and funded activation. There is no pre-graduation timeout refund.

Funding uses 3–5 distinct reviewers, excludes the beneficiary and requires a strict
majority (default 2 of 3; supported model thresholds 2 or 3). Milestone weights sum to
10,000 bps. Deadlines are strictly increasing offsets from activation, at most ten years,
and cannot be extended. Each reviewer can vote once per milestone; masks reset only on
successful advancement. Approval releases the immutable milestone budget only to the
beneficiary. Majority rejection or permissionless expiry irreversibly enables refunds.
Full approval completes the escrow; subsequently donated residual capital remains
redeemable by burning tokens. Reviewers remain trusted for milestone judgments.

Reserve deposits create no new tokens or withdrawal entitlement for the donor. Redemption
and escrow refunds use `floor(burn * actual_quote_balance / actual_unburned_mint_supply)`.
The denominator includes wallet, team and LP tokens. A holder must sign, own the burned
account and own the quote receiver. Burn and payout are one atomic transaction; a failed
transfer rolls back the burn. The caller supplies a positive `min_payout`, and dust/zero
outputs fail. Amounts are u64; products use checked-range u128 arithmetic. Exit fee is zero.

This is a share of remaining capital, not a refund of a buyer's original payment or a
market-price guarantee. External burns and donations change subsequent quotes. LP tokens
permanently trapped in liquidity can leave a permanent reserve remainder. No administrator
can sweep that remainder, change entitlements, extend deadlines or mint extra rights.

## Authority matrix

| Action | Authority / constraint |
|---|---|
| Initialize platform | Actual registry loader ProgramData upgrade authority |
| Pause new launches/publications | Platform authority; existing redemption/voting continues |
| Stage/seal a model | Its publisher; hash and inherited royalty terms verified |
| Declare/configure launch; initialize module | Registered launcher |
| Migrate native pool | Native Meteora permissionless rules |
| Verify migration; fund and activate | Permissionless, bound accounts, immutable states, replay protection |
| Initialize/activate module directly | Registry-owned launch PDA signature through fixed CPI |
| Vote | Member of the immutable reviewer set |
| Mark expired milestone | Permissionless after its fixed deadline |
| Redeem/refund | Token holder signature and owned SPL accounts |
| Donate | Source token-account owner signature |
| Change deployed code | Local upgrade authority; revoke after audit and release acceptance before public funds |

The platform authority cannot directly withdraw vault capital. A program upgrade authority
can replace code and therefore remains a privileged trust boundary until revoked. New
production versions must use new program IDs after revocation, with release-specific IDs
and native program/config validation. No mainnet deployment is performed by these scripts.

## Backend integration

The production implementation stays Rust: Axum/SQLx API, worker and the native helper.
Generated Anchor account/instruction types build the closed contract action set. The API
simulates exact unsigned messages, persists them, verifies all client signatures against
the stored message and uses the existing durable broadcast/finality worker.

- `POST /api/v1/contracts/models/encode`: wallet-authenticated canonical economy-to-model encoding.
- `POST /api/v1/contracts/prepare`: wallet/session, origin and CSRF-protected preparation,
  including native DFS creation with `create_fee_vault`. Supply `fee_base`, `launcher`,
  `quote_mint` and `args.recipients`; the client signs with the wallet and fresh base key.
  The factory subsequently validates those recipients against the sealed model policy.
- `GET /api/v1/contracts/{kind}/{address}`: owner-checked finalized state.
- `POST /api/v1/contracts/{kind}/{address}/redemption-quote`: coherent finalized vault/mint/ATA quote.
- Existing transaction submit/get routes handle signing and receipt recovery.

Economy schema v2 adds module terms; omitted terms preserve schema v1 serialization/hash
shape. Funding requires reviewer threshold and milestone terms. Backed uses empty module
terms. The previous native-only schema v1 launch flow still rejects capital mechanisms.
Migration 0010 adds durable contract-account projections and receipt deduplication. Runtime
logs are decoded only inside the relevant program invocation. Capital events do not create
DFS fee entries. Projections are finalized current snapshots, not exact historical state.

Set `ENABLE_CONTRACTS=true` only on an accepted localnet/devnet deployment. Mainnet
configuration rejects that flag. RPC snapshots and program checks still depend on the
configured RPC operator; they do not prove remote program bytecode identity by themselves.

## Reproduction

Prerequisites: Rust 1.97.1, Anchor CLI 1.0.2, Node 22, PostgreSQL and `npm ci`.
`contracts/scripts/install-agave.sh` installs Agave 4.0.0 locally with a pinned archive hash.
The build uses platform tools 1.57 and SBF v3. Upstream DBC/DAMM/DFS Git revisions are pinned
in Cargo manifests and lockfiles. Official fixture provenance is recorded separately.

```bash
contracts/scripts/install-agave.sh
python3 backend/scripts/fetch-fixtures.py
npm run contracts:build
# Set a private PostgreSQL admin DATABASE_URL; never commit credentials.
npm run contracts:test
npm run contracts:security
# Optional genuine local RPC acceptance, using a separate ledger and loopback ports:
contracts/scripts/local-validator.sh
node -r ts-node/register contracts/tests/rpc-smoke.cjs
```

Build each program separately: workspace CPI feature unification can remove module
entrypoints. The build script checks tool versions, emits IDLs and artifact hashes, and
records local-only status in `build-manifest.json`. It generates an ignored local operator
keypair if needed. Program deployment keys remain ignored and are unnecessary for test
preloading. Existing ledgers ignore genesis preload changes: explicitly upgrade locally
with the owning operator or start a separately named fresh ledger when testing new binaries. The validator runs in
a separate Docker container on the private backend network. Only its RPC/WebSocket ports
are published on host loopback; faucet/gossip ports are not published. Only the public operator
address is supplied to genesis; its private key stays on the host. Agave 4 requires three io_uring syscalls; a pinned Moby default
seccomp profile adds only those for this trusted test validator. The API and worker keep
their default seccomp profile. See `ops/seccomp-provenance.json`.

The persistent Rust LiteSVM 0.17 driver is test-only; its account/clock injection commands
are never part of the API. Lifecycle evidence covers 4 mechanisms × 3 compounding settings,
actual native CPIs, refunds/redeems, attacks and a real Rust HTTP/worker/PostgreSQL acceptance
run using the restricted database role. The RPC smoke separately checks genuine loader
accounts and chain transactions. See [SECURITY.md](SECURITY.md) for findings and boundaries.
