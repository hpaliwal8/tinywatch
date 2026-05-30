import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/client/index.ts",
    server: "src/server/index.ts",
    types: "src/types/index.ts",
    cli: "src/cli.ts",
    "plugins/outbound": "src/plugins/outbound.ts",
    "plugins/retry": "src/plugins/retry.ts",
  },
  format: ["esm", "cjs"],
  dts: true,          // emits .d.ts (ESM) and .d.cts (CJS)
  clean: true,
  treeshake: true,
  splitting: true,    // needed so the lazy autocapture import becomes its own chunk
  sourcemap: true,
  target: "es2020",
  outDir: "dist",
});
