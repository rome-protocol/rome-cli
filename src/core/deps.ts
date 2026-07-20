import { createPublicClient, http } from "viem";

/** Minimal RPC surface the facts capabilities need — injectable so tests never hit the network. */
export interface RpcClient {
  getGasPrice(): Promise<bigint>;
  getBalance(address: string): Promise<bigint>;
}

export interface Deps {
  makeRpc: (rpcUrl: string) => RpcClient;
}

/** Real deps: a viem public client per chain RPC. */
export const defaultDeps: Deps = {
  makeRpc: (rpcUrl: string): RpcClient => {
    const client = createPublicClient({ transport: http(rpcUrl) });
    return {
      getGasPrice: () => client.getGasPrice(),
      getBalance: (address: string) => client.getBalance({ address: address as `0x${string}` }),
    };
  },
};
