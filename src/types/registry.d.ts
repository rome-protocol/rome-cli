// Ambient types for @rome-protocol/registry (plain ESM, ships no .d.ts).
declare module "@rome-protocol/registry" {
  export function listChains(): Array<Record<string, unknown> & { chainId: number; name: string }>;
  export function getChain(chainId: number): (Record<string, unknown> & { chainId: number; name: string }) | null;
  export function getTokens(chainId: number): Array<Record<string, unknown>> | null;
  export function getContracts(chainId: number): Record<string, unknown> | null;
  export function getOracle(chainId: number): Record<string, unknown> | null;
  export function getBridge(chainId: number): Record<string, unknown> | null;
  export function getAlts(chainId: number): Record<string, unknown> | null;
  export function getPrograms(network: string): Record<string, string>;
  export function getLstMints(): Record<string, unknown>;
}
