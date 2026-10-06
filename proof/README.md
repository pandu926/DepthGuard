# Migration-continuity regression

This independent suite checks whether a bounded terminal DBC segment can match DAMM v2 sell execution at matched terminal price and capital. It uses pinned official SDKs and actual compiled-program execution in LiteSVM.

```bash
npm ci
python3 backend/scripts/fetch-fixtures.py
npm run test:proof
```

Run these commands from the repository root. For a standalone proof workspace, use `npm ci --prefix proof` and `npm --prefix proof run fixtures` first.

The suite creates native DBC/DAMM configurations, trades to graduation, executes migration, checks vault conservation and permanent LP lock, and compares SDK quotes, native simulation, and independent decimal calculations. Sensitivity cases include different capital, migration fees, terminal boundaries, and a mismatched-fee negative control.

Generated results are written to ignored `results/`. Program fixtures are downloaded into ignored `fixtures/` and verified against `fixture-manifest.json`; no keypairs or public transactions are required.

The result is bounded continuity, not universal outperformance. No liquidity is created by matching the terminal curve; large sells can leave the matched range, and equal post-migration reserves imply equal destination depth. Local test fixtures do not establish public-network bytecode equivalence.

See [economy mathematics](../docs/ECONOMY_MODELS.md) and [verification](../docs/VERIFICATION.md) for the application-level scope.
