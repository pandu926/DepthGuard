# Devnet release reference

Public application: <https://depthguard.rbexp.com>. This release uses official Solana Devnet; Mainnet broadcasting is disabled.

## Program IDs

| Program | Address |
| --- | --- |
| DepthGuard Registry | `5sUGNQ5pymevqfVmg99rgQ2jM4aVSo6RqhJtSK7VrPYz` |
| DepthGuard Escrow | `8zEaBFNNVDx9U4Cr111xfZjUmX7JMBapJhd6yT4XwtuZ` |
| DepthGuard Reserve | `7kaGXYpxPuCoh5o2AhxRoU8F13UUkHjfxVZUTYsKG88Y` |
| Meteora DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| Meteora DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| Meteora DFS | `dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh` |

[Deployment evidence](../contracts/tests/evidence/devnet-deployment.json) records the bytecode verification and platform initialization. [Build manifest](../contracts/build-manifest.json) identifies the release artifacts. Program addresses are public identifiers, not wallet credentials.

## Read-only preflight

```bash
DEVNET_RPC_URL=https://api.devnet.solana.com npm run web:devnet:preflight
```

The preflight checks the Devnet genesis hash and expected executable programs, then compares deployment and lifecycle evidence to the recorded release manifest. Public RPC rate limits or availability can affect this check. A passing result is Devnet-only acceptance.

## Private deployment configuration

For an operator-owned deployment, configure:

- `SOLANA_CLUSTER=devnet` and an HTTPS RPC whose genesis hash matches Devnet.
- `APP_ORIGIN` with the exact HTTPS frontend origin.
- Database credentials, signer encryption key, fixed helper paths, and supported migration config.
- Program and platform authority keypairs locally, outside version control.
- `ENABLE_CHAIN_WRITES` and `ENABLE_CONTRACTS` only after deployment checks pass.

RPC credentials can be read from an ignored file through the release scripts. Never commit a provider URL containing a private API key. The scripts do not use the global CLI wallet as an implicit signing authority.

The published IDs cannot be redeployed or upgraded from a clean checkout without their private authorities. An independent deployment requires its own identities and a consistent rebuild of program IDs, IDLs, clients, and release configuration.

API, database, metrics, and validator ports stay private. Serve the frontend and `/api/v1` proxy through HTTPS. See [frontend transport](FRONTEND.md) and [backend operations](../backend/README.md).

## Acceptance boundary

The recorded [browser run](../web/tests/evidence/frontend-devnet-report.md) uses five test launches and 97 finalized application transactions. The full [reproduction harness](../web/tests/FRONTEND-DEVNET.md) requires funded Devnet wallets and operator setup.

Devnet assets have no Mainnet balance equivalence. An upgrade authority remains a trust boundary while retained. Independent audit and production operational acceptance are still required before a Mainnet release.
