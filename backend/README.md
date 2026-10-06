# Rust backend

The consumer backend uses Rust, Axum, SQLx, and PostgreSQL. It persists wallet sessions, immutable economy versions, research jobs, launch workflows, prepared transactions, finalized receipts, fee accounting, and contract projections.

Native Meteora integration uses pinned Rust DBC, DAMM v2, and Dynamic Fee Sharing dependencies. A separate Rust helper executes checksum-verified native programs in LiteSVM. TypeScript provides independent verification tooling and the web application; it is not a production SDK bridge.

The current public release is verified on Devnet. Mainnet broadcast remains disabled. See [release configuration](../docs/DEVNET.md) and [verification scope](../docs/VERIFICATION.md).

## Workspaces

| Path | Responsibility |
| --- | --- |
| `crates/domain` | Typed economy rules, canonical identities, money, and transaction validation |
| `crates/application` | Authentication and research/transaction workflows |
| `crates/infrastructure` | SQL persistence, RPC, indexing, signer encryption, relay, and native integration |
| `crates/api` | Axum handlers, authorization, admission limits, and OpenAPI |
| `crates/worker` | Leased jobs, broadcast/finality recovery, indexing, and outbox |
| `native` | Official pinned Solana/Anchor quote and instruction dependencies |
| `sbf` | Isolated Rust LiteSVM runtime |

Separate native and SBF workspaces contain incompatible upstream dependency families. Helpers use bounded JSON IPC and fixed configured executables, with timeout and process limits.

## Build and test

```bash
npm ci
npm run backend:build
python3 backend/scripts/fetch-fixtures.py
# Set DATABASE_URL to a dedicated test database with database-creation privileges.
npm run backend:test
npm run backend:proof
npm run backend:e2e
npm run backend:contract
npm run check
```

Use Rust 1.97.1, Node.js 22, Python 3, and PostgreSQL 17 client tools. Lockfiles are committed. The fixture fetcher verifies immutable source commits and SHA256 checksums. HTTP acceptance creates its own test database and local RPC/API ports; it sends no public-network transactions.

OpenAPI is generated from Rust into `openapi.json`, then into `web/src/generated/backend-api.ts`. CI rejects generated contract drift.

## Configuration

[Local setup](../docs/GETTING_STARTED.md) documents Docker Compose. `.env.example` contains placeholders, not deployable credentials. Generate separate database passwords and a 32-byte hex signer-encryption key. `PLATFORM_FEE_WALLET` is a public address.

For host processes, set `DATABASE_URL`, `APP_ORIGIN`, `SOLANA_CLUSTER`, `SOLANA_RPC_URLS`, `NATIVE_HELPER_PATH`, `SBF_HELPER_PATH`, `SBF_FIXTURES_DIR`, and `ARTIFACTS_DIR`. Run `depthguard-api migrate` using a privileged migration connection before starting API and worker with the restricted runtime connection.

PostgreSQL and the API bind to loopback in Compose. API and worker run as uid 10001 with limited capabilities; the API mounts immutable artifacts read-only. Ensure the configured host RPC is reachable from the container network. Containers use an explicit host-gateway entry.

## API lifecycle

1. Request a wallet challenge from `/api/v1/auth/challenges` with the configured Origin.
2. Sign the returned message and verify it through `/auth/verify`; retain the HttpOnly cookie and CSRF token.
3. Create and edit revision-checked model drafts, then publish an immutable version or fork an existing version.
4. Validate/compile supported economy terms or submit an owner-scoped research job.
5. Create a launch from an immutable version and prepare the ordered factory steps.
6. Sign the exact returned message and submit it through the transaction resource.
7. Follow durable transaction status until finality; use current native quotes for trading.
8. Sweep trading fees, claim allocated fees, and exercise the configured funding/reserve rights.

The served API contract is `/api/v1/openapi.json`. Non-read authenticated actions require matching Origin and `X-CSRF-Token`. Atomic token amounts are canonical decimal strings. Owner checks apply to drafts, datasets, jobs, launches, and prepared transactions; public catalog resources use separate access rules.

## Operations

Research jobs use leases, heartbeats, fencing, bounded concurrency, cancellation, and idempotent persistence. Transaction recovery reconciles broadcast ambiguity against observed finality. RPC failover checks cluster identity and bounds deadlines/retries. Readiness and liveness are separate resources.

Apply migrations explicitly; a code rollback does not automatically reverse schema changes. Runtime SQL grants exclude schema administration. Backup templates use encrypted off-host storage and private operator environment files; configure installation paths before use and test recovery in an isolated database.

Prometheus and alert templates are in `ops/`. Diagnostics exclude secrets. Fee snapshots distinguish observed vault funding from trading-fee events; project/reserve capital does not enter the royalty ledger.

See [architecture](../docs/ARCHITECTURE.md), [contract terms](../contracts/README.md), and [security](../SECURITY.md).
