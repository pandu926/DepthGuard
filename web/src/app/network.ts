export const NETWORKS = {
  localnet: { chain: "solana:localnet", label: "Localnet", test: true },
  devnet: { chain: "solana:devnet", label: "Devnet", test: true },
  "mainnet-beta": { chain: "solana:mainnet", label: "Mainnet", test: false },
} as const;
export function networkFor(cluster: string) {
  return NETWORKS[cluster as keyof typeof NETWORKS];
}
export function supportsNetwork(chains: readonly string[], cluster: string) {
  const network = networkFor(cluster);
  return !!network && chains.includes(network.chain);
}
export function networkInstructions(cluster: string) {
  const network = networkFor(cluster);
  if (!network)
    return "This application network is unsupported. Signing is unavailable.";
  return network.test
    ? `Enable test networks in your wallet settings, select ${network.label}, then reconnect. Fund the same address with ${network.label} SOL; Mainnet SOL cannot pay these costs.`
    : "Select Solana Mainnet in your wallet settings, then reconnect. Mainnet transactions use real SOL.";
}
