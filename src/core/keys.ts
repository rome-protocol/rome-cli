export const EVM_KEY_ENV = "ROME_EVM_KEY";

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
