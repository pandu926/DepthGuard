import type { Economy } from "./client";
export const WSOL = "So11111111111111111111111111111111111111112";
export function initialEconomy(
  author = "11111111111111111111111111111111",
): Economy {
  return {
    schema_version: 2,
    mechanism: "meme",
    base_decimals: 6,
    quote_decimals: 9,
    supply: "1000000000000000",
    sqrt_start_price: "23058460257381714",
    curve: [
      {
        sqrt_price: "92233720368547758",
        liquidity: "24595669490371110141701247394193",
      },
      {
        sqrt_price: "79226673521066979257578248091",
        liquidity: "3435948381715812206002449",
      },
    ],
    migration_quote_threshold: "5000000000",
    trade_fee_bps: 25,
    migration_fee_pct: 0,
    compounding_fee_bps: 0,
    fee_policy: {
      author,
      launcher_bps: 8000,
      author_bps: 1000,
      platform_bps: 1000,
    },
    native_config: null,
  };
}
export const mechanisms = [
  {
    id: "meme",
    title: "Community launch",
    text: "Price discovery, then permanent liquidity.",
    number: "01",
  },
  {
    id: "funding",
    title: "Milestone funding",
    text: "Release project capital through reviewer approval.",
    number: "02",
  },
  {
    id: "backed",
    title: "Reserve economy",
    text: "Burn tokens for a share of funded reserves.",
    number: "03",
  },
  {
    id: "asset_quote",
    title: "Asset markets",
    text: "Explore pricing in alternative asset units.",
    number: "04",
  },
] as const;
