import { createRequire } from "node:module";

// Single source of the released version — package.json — so the CLI banner and
// the MCP serverInfo can't drift from the tag.
export const PKG_VERSION: string = createRequire(import.meta.url)("../../package.json").version;
