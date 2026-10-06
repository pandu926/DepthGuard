# Security policy

## Supported release

DepthGuard is a Devnet release. Mainnet broadcasting is disabled. Recorded first-party tests are not an independent audit or production certification.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/pandu926/DepthGuard/security/advisories/new) when available. If that channel is unavailable, contact the repository owner to establish a private channel before sharing exploit details. Do not publish keys, credentials, personal data, or an exploit against a live service in an issue.

Include the affected component, release or commit, prerequisites, reproduction steps in an isolated environment, expected/actual behavior, and impact. A minimized regression is helpful.

## Trust boundaries

- Program upgrade authorities can replace deployed code while retained.
- Milestone reviewers judge off-chain delivery; contracts enforce their majority votes.
- RPC operators supply chain observations; account ownership and release verification remain explicit checks.
- Native Meteora and SPL programs are external dependencies with pinned integrations.
- Holder rights apply to actual remaining capital, not guaranteed purchase-price refunds or market values.
- Official forks preserve royalties within this deployment; independent deployments are outside that guarantee.

Authentication challenges are single-use and origin/cluster-bound. Prepared messages bind the signer, action, and expiry. The API verifies exact messages and required signatures; workers confirm finality before projecting state. PostgreSQL runtime permissions are separated from migration permissions.

The [contract security reference](contracts/SECURITY.md) contains the threat model, adversarial checks, arithmetic boundaries, and dependency maintenance notices. [Verification](docs/VERIFICATION.md) links recorded evidence and reproduction commands.

Never commit operator keypairs, wallet secrets, provider API keys, session material, or private deployment environment files. A successful dependency scan does not establish the absence of vulnerabilities.
