# Economy models and mathematics

## Executable profiles

A model combines price-discovery configuration, migration terms, fee policy, and supported post-launch holder rights. Launches commit to immutable executable terms.

| Profile | Capital after migration | Holder action |
| --- | --- | --- |
| Community | Liquidity remains in the destination market; no project-capital module | Trade on DBC and then DAMM v2 |
| Milestone funding | A defined allocation activates reviewer-governed escrow | Review progress; burn for remaining capital after rejection or expiry |
| Reserve | A defined allocation activates a quote-token reserve | Burn tokens for a proportional reserve payout |
| Asset quote | Extended quote-asset research | Requires a separately accepted issuer/quote adapter before execution |

The current factory accepts standard SPL tokens with WSOL quote. Funding and reserve rights activate only after verified migration and a positive capital transfer. There is no pre-graduation refund right.

## Curve representation

DBC configurations encode piecewise liquidity over square-root price intervals. Let `s = sqrt(p)` and `L` be the liquidity of a segment. Ignoring fees, a move from `s_a` to `s_b`, where `s_b > s_a`, requires:

```text
quote_in = L × (s_b − s_a)
base_out = L × (1/s_a − 1/s_b)
```

The native representation uses Q64 square-root prices, integer token amounts, and native rounding rules. Decimal previews are analytical representations; executable quotes come from the pinned native implementation and current accounts.

The supported compiler bounds the segment count and controls supply, decimals, graduation threshold, fixed fees, compounding, and migration allocation. The broader [native parameter inventory](research/NATIVE_PARAMETERS.md) lists fields exposed for expert research. An editable field is not automatically an independent control or an accepted executable feature.

## Migration and market depth

For a full-range non-compounding constant-product reference with base reserve `X`, quote reserve `Y`, and effective base input `dx_eff`:

```text
p_spot = Y / X
quote_out = Y × dx_eff / (X + dx_eff)
execution_shortfall = 1 − net_quote_out / (dx × p_spot)
```

Actual fees, collection modes, compounding, native rounding, and pool state must be included when evaluating a real trade. The formula above is a reference case, not a universal DAMM quote implementation.

The migration-continuity regression configures a terminal DBC segment to match sell execution over a bounded range at matched capital and terminal price. It does not create liquidity. Equal capital and equal destination reserves do not imply better post-migration depth; sufficiently large orders can leave the matched terminal range.

A migration allocation assigned to project or reserve capital reduces the capital delivered to market liquidity. Simulations must expose that tradeoff rather than presenting all raised capital as simultaneously available to both pools.

## Reserve redemption

Let `b` be the token amount burned, `V` the actual remaining quote balance, and `S` the actual unburned mint supply:

```text
payout = floor(b × V / S)
```

The programs use checked integer arithmetic and atomic burn-plus-transfer. The denominator includes team, wallet, and liquidity tokens. Donations and external burns change later quotes. A positive minimum payout protects the caller; zero or dust payouts fail.

This is a share of remaining capital, not a guarantee of the purchase price or market value. Permanently locked liquidity tokens can leave a permanent reserve remainder.

## Milestones

Milestone weights sum to 10,000 basis points. Reviewers and thresholds are immutable, distinct from the beneficiary, and require a strict majority. Budgets, deadlines, vote uniqueness, and transitions are enforced on-chain. Majority rejection or permissionless deadline expiry enables refunds; full approval completes the escrow.

Reviewer judgments about real-world delivery are trusted inputs. The contract enforces their votes, not the truth of off-chain work.

## Model-author economics

The default trading-fee policy is 80% launcher, 10% original author, and 10% platform. DFS merges recipients when addresses coincide. Official copies preserve original attribution and fee shares. The author participates in trading fees; this policy does not grant access to project or reserve capital.

Fee compounding reinvests trader-paid fees. It is not free yield, and reserve growth alone does not guarantee lower execution shortfall for every order size or direction.

## Research boundaries

Research supports analytical scenarios, comparisons, grids, and reproducible exports. Native structural validation checks field shapes and selected constraints. It is separate from complete semantic acceptance, snapshot binding, public-network execution, and historical market parity.

The [migration regression](../proof/README.md) and [contract reference](../contracts/README.md) describe the corresponding executable checks and constraints.
