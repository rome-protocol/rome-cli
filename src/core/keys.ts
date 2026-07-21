import { Keypair } from "@solana/web3.js";

export const EVM_KEY_ENV = "ROME_EVM_KEY";
export const SOLANA_KEY_ENV = "ROME_SOLANA_KEY";

/**
 * The signing key for actions, read from the environment ONLY — never a flag, never
 * logged, never passed through the MCP server. Throws a clear, actionable error if absent
 * or malformed. The returned key is used to build a viem account and is never printed.
 */
export function requireEvmKey(): `0x${string}` {
  const raw = process.env[EVM_KEY_ENV];
  if (!raw) {
    throw new Error(
      `No signing key. Set ${EVM_KEY_ENV} in your environment (a 0x-prefixed EVM private key). ` +
        `It is read from the environment only — never a flag, never logged, never sent through MCP.`,
    );
  }
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${EVM_KEY_ENV} is not a valid 32-byte hex private key.`);
  }
  return key;
}

/**
 * The Solana-lane signing key for `verify` (drives an EVM contract from a Solana
 * wallet), read from the environment ONLY — same rules as the EVM key. Accepts the
 * standard 64-byte secret-key JSON array (solana-keygen format).
 */
export function requireSolanaKey(): Keypair {
  const raw = process.env[SOLANA_KEY_ENV];
  if (!raw) {
    throw new Error(
      `No Solana signing key. Set ${SOLANA_KEY_ENV} in your environment (a JSON array of the 64-byte secret key). ` +
        `Read from the environment only — never a flag, never logged, never sent through MCP.`,
    );
  }
  let bytes: Uint8Array;
  try {
    const arr = JSON.parse(raw.trim());
    if (!Array.isArray(arr)) throw new Error("not an array");
    bytes = Uint8Array.from(arr);
  } catch {
    throw new Error(`${SOLANA_KEY_ENV} must be a JSON array of the 64-byte Solana secret key.`);
  }
  if (bytes.length !== 64) throw new Error(`${SOLANA_KEY_ENV} must be 64 bytes (got ${bytes.length}).`);
  return Keypair.fromSecretKey(bytes);
}
