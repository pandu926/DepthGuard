# Contributing

Read the [architecture](docs/ARCHITECTURE.md) and the relevant backend or contract reference before making a change. Use English for code comments, documentation, UI text, issues, and pull requests.

## Development workflow

1. Describe the problem and expected behavior in an issue or pull request.
2. Keep changes focused; preserve typed boundaries, pinned dependencies, and immutable published model semantics.
3. Run checks appropriate to the affected layer and include the results.
4. Explain user-visible behavior and any changes to transaction, authority, accounting, or migration assumptions.

```bash
npm ci
npm run check
npm run web:test
npm run build
npm run web:transport:test
```

For Rust changes, run workspace formatting, Clippy with warnings denied, and relevant tests. For on-chain changes, build each Anchor program separately and run compiled-SBF acceptance. API changes must regenerate OpenAPI and the frontend contract with `npm run backend:contract`.

Use a dedicated test database. Do not submit public-network transactions as part of ordinary CI. Real Devnet acceptance requires an explicit operator setup and funded test wallets.

## Repository conventions

- Token amounts crossing API boundaries are canonical integer strings.
- UI gating complements backend/program checks; it never replaces them.
- Evidence must state environment, artifact identity, assumptions, and limits.
- Keep private keys, provider credentials, session tokens, generated binaries, logs, and local working files out of commits.
- Preserve third-party license notices and upstream fixture provenance.
- Use clear, imperative commit subjects and include meaningful validation in pull requests.

Report sensitive findings through [the security process](SECURITY.md), not a public issue.
