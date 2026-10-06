// Public, normalized demonstration models. These are not launch configurations.
export const economies = [
  {
    name: "Community",
    title: "A market for your community.",
    description:
      "Launch a token, discover its price, and graduate into an open liquidity pool.",
    curve: "Accelerating discovery",
    allocation: "Market liquidity",
    rights: "Open trading",
    doc: "community-launch",
    power: 1.8,
  },
  {
    name: "Milestone funding",
    title: "Capital with a purpose.",
    description:
      "Pair a token launch with defined milestones, reviewer decisions, and explicit holder rights.",
    curve: "Measured discovery",
    allocation: "Milestone escrow",
    rights: "Conditional refunds",
    doc: "milestone-funding",
    power: 1.1,
  },
  {
    name: "Reserve-backed",
    title: "A reserve. A clear set of rights.",
    description:
      "Define a reserve allocation and burn-to-redeem rules alongside the market itself.",
    curve: "Gentle discovery",
    allocation: "Redemption reserve",
    rights: "Burn to redeem",
    doc: "reserve-economy",
    power: 0.6,
  },
  {
    name: "Asset-quoted",
    title: "Explore a different unit of value.",
    description:
      "Research markets quoted in other assets. Consumer launch support remains gated.",
    curve: "Quote exploration",
    allocation: "Research scenario",
    rights: "Research only",
    doc: "asset-markets",
    power: 1.4,
  },
] as const;
