#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv)
  .then((code) => {
    // A number = a finished command; exit with it. void = a long-running server
    // (rome mcp) that must keep the process alive on stdin — don't exit.
    if (typeof code === "number") process.exit(code);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
