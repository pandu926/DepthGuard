# Live frontend devnet acceptance

Run `npm run web:devnet:frontend` from the repository root. This test drives the public HTTPS frontend with Playwright and signs real devnet transactions through a Wallet Standard adapter. The persisted keypairs remain in Node; private keys are never exposed to the page or committed.

The harness performs no direct application API calls, database writes, request mocking, or browser draft injection. Economy fixtures are imported through the Studio file picker. Application requests and finalized receipts are observed passively. Direct RPC use is restricted to checking devnet identity, funding the test wallet from the existing devnet authority, checking balances, and independently verifying transaction finality. Funding is a setup operation rather than a DepthGuard UI feature.

A fresh run budgets 2 devnet SOL for the creator and checks that the existing devnet authority can fund the shortfall. Existing funded reviewer and trader wallets are reused. Completed financial workflows do not trigger another funding transfer.

Prerequisites: the existing devnet deployment and running web/API/worker services, `.local/devnet/rpc-url`, and persisted creator/reviewer/authority keypairs under `.local/devnet/keys`. The harness does not restart services or change deployment configuration. Mainnet signing is rejected by the adapter.

Evidence is persisted in `evidence/frontend-devnet.json`; screenshots remain in the ignored `.local/frontend-e2e` directory. Checkpoints allow unfinished runs to resume without recreating completed launches. A completed evidence file represents that recorded run; archive it before requesting a fresh acceptance run. Failed assertions remain recorded until the resumed run completes.

The intended coverage includes:

- Wallet connection and signed authentication over HTTPS; reload and reconnect.
- SOL wrapping and unwrapping, wallet rejection with unchanged balance, and a separate real holder buying, selling and redeeming.
- Community, reserve, and milestone funding launch wizards and each factory signing step.
- DBC buys and sells, graduation with partial input consumption, migration to DAMM v2, and DAMM buys.
- Reserve donation and burn redemption.
- Real reviewer approvals, a milestone release, rejection of the subsequent milestone, and holder refund. Fully approved completion and milestone expiration with refunds use two additional launches.
- DBC/DAMM fee sweeps and recipient claims.
- Studio parameter editing, native structural validation, immutable publication, executable registration, forks, model import/export, and author preservation.
- All nine Simulation Lab scenario selectors, research jobs and cancellation (including completion races), baseline pinning, and evidence export.
- Token search/filter, model search, creator draft navigation, clipboard copying, activity pagination, transaction receipts, and documentation search.
- Desktop routes, mobile layout checks, malformed imports, invalid metadata URI schemes, unauthorized reviewer controls, and an unfunded wallet swap rejection.

## Scope of the result

Use the completed checkpoints and transaction signatures in the JSON evidence to determine which checks actually passed. A visible page alone is not proof of a completed transaction or economic correctness. Analytical previews are not historical market parity or forecasts.

The signer is a real wallet keypair behind an automated adapter. These checks do not establish compatibility with the Phantom or Solflare extension UI. Mainnet deployment, asset-quote execution, browser extension approval prompts, adversarial security certification, worker interruption recovery, external metadata hosting, and sustained load require separate acceptance evidence. A passing devnet run is not production certification.
