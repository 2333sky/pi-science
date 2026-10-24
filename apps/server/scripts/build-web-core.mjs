import { build } from "esbuild";
import { fileURLToPath } from "node:url";
// The pinned package publishes its host-neutral core as TS. Bundle that core
// for production Node, without importing the Pi extension or an MCP server.
await build({
  entryPoints: [fileURLToPath(new URL("../src/web/upstream-adapter.mjs", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/web/upstream-core.js", import.meta.url)),
  external: ["defuddle/node"],
  bundle: true, platform: "node", format: "esm", target: "node24",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
