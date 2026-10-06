# Getting started

## Try the Devnet application

1. Open [DepthGuard](https://depthguard.rbexp.com). First-time Explore visitors receive a three-step onboarding guide.
2. Choose Explore & trade, Launch a token, or Design an economy. Browsing and local configuration do not require a wallet.
3. Connect a Wallet Standard wallet that supports Solana Devnet. Enable test networks in the wallet and check the network in the approval screen; connecting does not change the wallet's displayed network.
4. Sign the authentication message when accessing account workspaces. Authentication itself has no network fee.
5. Fund the same address with Devnet SOL through the [Solana faucet](https://faucet.solana.com). Mainnet SOL cannot pay Devnet costs.
6. For SOL-quoted trading, wrap SOL to WSOL in Portfolio. Retain SOL for fees and account creation.

Review every quote and transaction. A completed onboarding guide does not imply that a wallet is funded. Reopen the guide through Getting started in navigation.

## Install dependencies

```bash
npm ci
npm run check
npm run web:test
npm run build
```

Node.js 22 is required. For Rust workspaces use Rust 1.97.1; each workspace contains its lockfile.

## Run the backend locally

The default setup is read-only localnet with chain writes disabled. It requires a running PostgreSQL instance; Docker Compose provisions it together with the API and worker.

```bash
mkdir -p .local
cp backend/.env.example .local/backend.env
chmod 600 .local/backend.env
openssl rand -hex 32
```

Edit `.local/backend.env` and set independent random values for `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` (64 hexadecimal characters), and `KEY_ENCRYPTION_KEY` (a separate 64-character hexadecimal value). Set `APP_ORIGIN=http://127.0.0.1:5174` for Vite development. Keep `ENABLE_CHAIN_WRITES=false` and `ENABLE_CONTRACTS=false` until the selected deployment is configured and accepted.

```bash
install -d -m 750 backend/artifacts
sudo chown 10001:10001 backend/artifacts
docker compose --env-file .local/backend.env -f backend/compose.yaml --profile app up -d --build
curl --fail http://127.0.0.1:8800/health/ready
curl --fail http://127.0.0.1:8800/api/v1/capabilities
npm run dev
```

Open `http://127.0.0.1:5174`. Vite proxies `/api` to the private Rust API on port 8800. Use `DEPTHGUARD_API_PORT` to change the upstream port. The chain-dependent launch and trading paths require a reachable validator or configured Devnet RPC and accepted program deployment; a read-only startup does not provision those programs.

The runtime database user is `depthguard_app`; migration uses a separate privileged connection. Never run tests against a customer database.

## Enable on-chain development

Follow [contract reproduction](../contracts/README.md#reproduction) for an isolated local validator, or [Devnet configuration](DEVNET.md) for the existing release. Supply the supported migration config and public fee recipient. Generate operator keys locally; deployment and wallet secrets are never part of this repository.

See the [backend reference](../backend/README.md) for host binaries, encrypted signer storage, and operations.
