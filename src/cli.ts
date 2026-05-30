#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DbAdapter } from "./types";

const [cmd] = process.argv.slice(2);

async function loadConfig(): Promise<{ adapter: DbAdapter }> {
  // Looks for tinywatch.config.{mjs,js} in cwd exporting { adapter }.
  for (const file of ["tinywatch.config.mjs", "tinywatch.config.js"]) {
    let mod: Record<string, unknown>;
    try {
      mod = await import(pathToFileURL(resolve(process.cwd(), file)).href);
    } catch (err) {
      // Only treat a genuine "file not found" as "try the next filename". Any
      // other error means the config exists but failed to load (syntax/runtime
      // error) — surface it instead of the misleading "could not find" below.
      if (err instanceof Error && "code" in err && err.code === "ERR_MODULE_NOT_FOUND") {
        continue;
      }
      throw new Error(`tinywatch: failed to load ${file}: ${err instanceof Error ? err.message : err}`);
    }
    const cfg = (mod.default ?? mod) as { adapter?: DbAdapter };
    if (cfg?.adapter) return cfg as { adapter: DbAdapter };
    throw new Error(`tinywatch: ${file} loaded but does not export { adapter }`);
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
