import { createPublicClient, createWalletClient, http, type Account } from "viem";

/**
 * A minimal EIP-1193 provider backed by a viem account, so the SDK's `submitRomeTx`
 * — which expects an injected wallet like `window.ethereum` — can run in Node with a
 * key from the environment. Answers `eth_accounts`/`eth_chainId` locally, signs +
 * broadcasts `eth_sendTransaction`, and forwards every read to the RPC.
 * (Standard pattern, mirrors create-rome-app's template shim.)
 */
export function eip1193FromAccount(account: Account, rpcUrl: string, chainId: number) {
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, transport: http(rpcUrl) });
  const big = (v: unknown) => (v === undefined || v === null ? undefined : BigInt(v as string));
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [account.address];
        case "eth_chainId":
          return `0x${chainId.toString(16)}`;
        case "eth_sendTransaction": {
          const t = ((params ?? [])[0] ?? {}) as Record<string, unknown>;
          return wallet.sendTransaction({
            to: t.to as `0x${string}` | undefined,
            data: t.data as `0x${string}` | undefined,
            value: big(t.value),
            gas: big(t.gas),
            maxFeePerGas: big(t.maxFeePerGas),
            maxPriorityFeePerGas: big(t.maxPriorityFeePerGas),
          } as Parameters<typeof wallet.sendTransaction>[0]);
        }
        default:
          return pub.request({ method: method as never, params: params as never });
      }
    },
  };
}
