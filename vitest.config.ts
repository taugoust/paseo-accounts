import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Use the same pinned, bundled helper implementation as the production compiler.
const compiler = process.env.PASEO_PLUGIN_COMPILER;
export default defineConfig({
  resolve: compiler
    ? {
        alias: {
          "@getpaseo/plugin/shared": createRequire(resolve(compiler)).resolve(
            "@getpaseo/plugin/shared",
          ),
        },
      }
    : undefined,
});
