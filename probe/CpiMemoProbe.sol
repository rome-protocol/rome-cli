// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

// Minimal CPI wrapper for `rome verify --path solana-program`. Proves an EVM-lane
// call drives a Solana program (SPL Memo) through the CPI precompile (0xff..08),
// signing as this contract's own external-auth PDA — the "bring your Solana
// program" pattern, reduced to its smallest honest form. Compiled with solc 0.8.36.

interface ICpi {
    struct AccountMeta {
        bytes32 pubkey;
        bool is_signer;
        bool is_writable;
    }
    function invoke(bytes32 program_id, AccountMeta[] memory accounts, bytes memory data) external;
}

interface IHelper {
    function pda(address user) external view returns (bytes32);
    function create_pda(address user) external;
}

contract CpiMemoProbe {
    ICpi private constant CPI = ICpi(0xFF00000000000000000000000000000000000008);
    IHelper private constant HELPER = IHelper(0xff00000000000000000000000000000000000009);
    // SPL Memo v2 (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr) as bytes32.
    bytes32 private constant MEMO = 0x054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d;

    constructor() {
        // Provision this contract's external-auth PDA so the CPI precompile can sign as it.
        HELPER.create_pda(address(this));
    }

    // CPI into SPL Memo with this contract's PDA as the sole (required) signer account.
    // A failed CPI reverts this call — that revert is the works-gate's negative signal.
    function ping(string calldata memo) external {
        ICpi.AccountMeta[] memory accts = new ICpi.AccountMeta[](1);
        accts[0] = ICpi.AccountMeta({ pubkey: HELPER.pda(address(this)), is_signer: true, is_writable: false });
        CPI.invoke(MEMO, accts, bytes(memo));
    }
}
