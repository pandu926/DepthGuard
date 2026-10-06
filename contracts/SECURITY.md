# Security review and adversarial acceptance

This is a first-party implementation review and automated adversarial test suite. It is
not an independent audit, exhaustive vulnerability assessment or production certification.
All execution is confined to isolated local runtimes and the loopback validator. No public
network transactions, third-party scans or access attempts are performed.

## Threat model

Attackers may submit arbitrary instructions, choose fresh accounts and native migration
signers, own tokens, create extra SPL accounts with PDA authorities, donate capital, race
valid transactions, fork models, send malformed HTTP requests and replay signatures.
They do not control the Solana runtime, SPL program, native Meteora code, our fixed program
IDs, a quorum of honest reviewers, the operator's configured RPC or upgrade authority.
Those are explicit trust boundaries. A compromised reviewer majority can approve undeserved
milestones; the program cannot determine whether real-world work was delivered.

Review covers first-party Anchor logic, native CPI account relationships, arithmetic,
HTTP access control, exact message binding, finalized receipts and projection recovery.
Native dependency source is pinned and fixtures are checksum verified. This review does
not replace a review of native Meteora, SPL, validator or cryptographic implementations.

## Findings fixed during implementation

| Finding | Effect before hardening | Fix and regression |
|---|---|---|
| Alternative reserve account | Checking only mint/authority could accept a separate SPL account owned by the vault PDA, disconnecting redemption from the canonical reserve balance | Enforce the canonical ATA at funding, activation, voting, deposit and redemption; adversarial harness creates a real extra SPL account and verifies rejection |
| Anticipated migration NFT | A permissionless native migrator can use a different fresh position mint, causing verification to reject a valid graduation and strand activation | Reproduced against compiled SBF with `InvalidTerms`; verify native position/NFT PDAs, immutable pool identity, permanent lock and DFS ownership, then record the actual NFT mint |
| Module initialization order | Permissionless verification could move a launch to phase 3 before its launcher initialized the module | Permit authorized module initialization in phases 2 and 3; regression combines delayed initialization with a different migration NFT |
| Agave RPC publication | The test-validator RPC listener binds all interfaces despite its gossip `--bind-address` setting | Run in a separate container and publish RPC/WebSocket only on host loopback; verify actual listening addresses |
| Projection role injection | Arbitrary extra account labels could misdirect receipt projections if every supplied role was indexed | Project only the action-specific model/launch/module roles |

The first finding is prevention of a split-reserve-account failure, not proof that funds
were stolen from a deployed service. These changes were completed before any public release.
The implementation also caught and corrected an overbroad beneficiary ATA constraint;
full approval/rejection/completion tests verify the corrected recipient relationship.

## Executed checks

The checked-in [lifecycle evidence](tests/evidence/lifecycle.json) records successful native
execution receipts and named rejected attacks. The [RPC evidence](tests/evidence/rpc-smoke.json)
records actual local validator transactions and genuine ProgramData bootstrap acceptance.
Build hashes identify the tested artifacts. Keypairs and database credentials are excluded.

- Four mechanism tags with compounding 0%, 50% and 100%; actual DBC creation, graduation,
  DAMM migration, permanent LP ownership and native DFS fee sweeps.
- Official copies preserve original author; a copy changing inherited royalty shares fails.
- Foreign publisher/launcher/reviewer/holder rejection, wrong mint/program/module rejection,
  alternative vault ATA rejection and capital redirection rejection.
- Duplicate publication mutation/vote/funding rejection, expired milestone vote rejection,
  reviewer majority approval, majority rejection, expiry and complete approval paths.
- Zero burns/minimums, excessive burns and minimum-payout failures preserve balances.
- A transaction submitted directly to the runtime burns first, then hits an injected frozen
  receiver transfer failure; holder, supply and reserve balances remain unchanged. The freeze
  fixture is test-only fault injection; native WSOL has no issuer freeze authority.
- Positive reserve top-up changes backing without minting additional rights; completed
  escrow donations remain burn-refundable.
- Property tests cover exact floor arithmetic at u64 extremes, sequential redemption
  conservation, milestone budget conservation, digest identity binding, invalid reviewers,
  tiny budgets, duplicate votes and deadline/overflow boundaries.
- HTTP session, CSRF and origin enforcement, login nonce replay, foreign role substitution,
  arbitrary action rejection, noncanonical amount rejection and signed-message tampering.
- Genuine API signing/submission, worker finality, versioned program log events and durable
  contract projections in PostgreSQL using `depthguard_app`.
- Formatting, strict Clippy, backend regression tests, generated OpenAPI/TypeScript contract,
  dependency audit and build verification.

RustSec scans of contract, runner and native-helper lockfiles reported zero known security
vulnerabilities during this run. They did report unmaintained transitive dependencies:
`bincode`, `derivative`, `paste`, and, in the test runtime, `ansi_term` and `libsecp256k1`.
These are recorded maintenance risks in upstream Solana/Anchor/runtime dependencies;
zero RustSec findings does not mean the code has no vulnerabilities. Re-run audits in CI.

## Economic and operational boundaries

Redemption conserves the actual reserve. It cannot promise an original purchase-price
refund, market liquidity or profit. Migration allocations reduce destination liquidity.
All unburned tokens count in the denominator; permanently locked LP balances can leave
capital permanently unrecoverable. There is deliberately no administrative sweep.
Before graduation there are no module rights. If a token never graduates, this release
provides no alternate timeout refund. Donation and external-burn effects are visible in
new quotes and bounded at execution by `min_payout`.

Model JSON hashes are descriptive commitments; executable Borsh and on-chain accounts
are authoritative. Account RPC responses require a trusted configured provider and correct
cluster. Current projections ingest platform-submitted finalized receipts; a global index
of all externally submitted actions is outside this delivery. Public state/quotes still read
the chain directly. The legacy native-only launch flow is separate from the new factory.

Before public funds: independent audit, deployed bytecode/config/quote verification,
target-network lifecycle and recovery acceptance, external wallet/frontend integration,
load/edge protection and operations acceptance, then irrevocable upgrade-authority removal.
Mainnet broadcast remains blocked. Local/devnet authorities remain upgradeable for testing.

## Local validator isolation

The validator uses an isolated Docker ledger and private backend network. Host bindings
for ports 18999 and 19000 are explicitly `127.0.0.1`; faucet and gossip ports are not
published. Migration 0010 is applied to the task-owned backend database after a private
backup; other services and nginx configuration are not changed. Backend API/worker run as
the existing restricted application/database user.

Agave 4 requires io_uring for account-file operations. Docker's default seccomp profile
blocks those calls because of kernel attack-surface concerns ([Docker documentation](https://docs.docker.com/engine/security/seccomp/)). The trusted local test-validator profile
is derived from a pinned Moby revision and permits only the three required additional
syscalls. This increases its kernel interface exposure and is not a production validator
hardening certification. No capabilities or privileged mode are enabled; filesystem mounts
are limited, the root filesystem is read-only, and the private operator key is not mounted. API/worker restrictions stay unchanged.
