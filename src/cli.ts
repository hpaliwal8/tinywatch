#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DbAdapter } from "./types";

const [cmd] = process.argv.slice(2);

async function loadConfig(): Promise<{ adapter: DbAdapter }> {
  // Looks for tinywatch.config.{mjs,js} in cwd exporting { adapter }.
  for (const file of ["tinywatch.config.mjs", "tinywatch.config.js"]) {
    try {
      const mod = await import(pathToFileURL(resolve(process.cwd(), file)).href);
      const cfg = mod.default ?? mod;
      if (cfg?.adapter) return cfg;
    } catch {
      // try the next filename
    }
  }
  throw new Error("tinywatch: could not find tinywatch.config.{mjs,js} exporting { adapter }");
}

async function main(): Promise<void> {
  switch (cmd) {
    case "migrate": {
      const { adapter } = await loadConfig();
      await adapter.migrate();
      console.log("✓ tinywatch: schema migrated");
      break;
    }
    default:
      console.log("Usage: tinywatch migrate");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
