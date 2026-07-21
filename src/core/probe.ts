// A minimal `Store` probe (solc 0.8.36, optimized): `set(uint256)` / `get()→uint256`.
// `rome verify` deploys it, then drives set/get from BOTH lanes to prove the same
// contract answers on the EVM lane and the Solana lane. Source: scratchpad probe/Store.sol.
export const STORE_PROBE = {
  abi: [
    { inputs: [], name: "get", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [{ internalType: "uint256", name: "x", type: "uint256" }], name: "set", outputs: [], stateMutability: "nonpayable", type: "function" },
  ],
  bytecode:
    "0x6080604052348015600e575f5ffd5b5060a580601a5f395ff3fe6080604052348015600e575f5ffd5b50600436106030575f3560e01c806360fe47b11460345780636d4ce63c146045575b5f5ffd5b6043603f3660046059565b5f55565b005b5f5460405190815260200160405180910390f35b5f602082840312156068575f5ffd5b503591905056fea2646970667358221220960bbcb62c68f5e98b5bca2ceac80403075d01943318403b5e8bcf09cff64a0b64736f6c63430008240033",
} as const;
