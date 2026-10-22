/** Bundle the production worker for Windows IPC tests; keep runtime assets at
 * their original locations and preserve exact pnpm versions for external SDKs. */
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import { isBuiltin } from "node:module";

// Keep native sandbox assets and provider SDKs in their normal package context.
// Splitting preserves lazy provider loading; eager pure-JS dependencies are bundled.
const externalPackages = new Set(["@anthropic-ai/sandbox-runtime", "pi-web-access", "openai", "@anthropic-ai/sdk",
  "@google/genai", "google-auth-library", "@huggingface/inference", "@mistralai/mistralai"]);
const entry = fileURLToPath(new URL("../dist/runtime/agent/worker/main.js", import.meta.url));
const outfile = fileURLToPath(new URL("../dist/runtime/agent/worker/main.test-bundle.mjs", import.meta.url));
await build({
  entryPoints: { "main.test-bundle": entry }, outdir: fileURLToPath(new URL(".", pathToFileURL(outfile))),
  outExtension: { ".js": ".mjs" }, chunkNames: "test-worker-chunks/[name]-[hash]", splitting: true, bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: true,
  banner: { js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);' },
  plugins: [{
    name: "preserve-worker-module-context",
    setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.kind === "entry-point" || args.pluginData?.externalLookup) return;
        const name = args.path.startsWith("@") ? args.path.split("/").slice(0, 2).join("/") : args.path.split("/")[0];
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        if (["bufferutil", "utf-8-validate", "fsevents"].includes(name)) return { path: args.path, external: true };
        if (!externalPackages.has(name) && !name.startsWith("@aws-sdk/") && !name.startsWith("@smithy/")) return;
        const resolved = await builder.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir,
          importer: args.importer, pluginData: { externalLookup: true } });
        if (resolved.errors.length) return { errors: resolved.errors };
        return { path: resolved.external ? resolved.path : pathToFileURL(resolved.path).href, external: true };
      });
      builder.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        // Use the parser, so strings/comments containing import.meta.url are
        // untouched. Runtime asset lookups retain the original module URL.
        const result = await transform(source, { loader: "js", target: "node24",
          define: { "import.meta.url": JSON.stringify(pathToFileURL(args.path).href) } });
        return { contents: result.code, loader: "js", resolveDir: fileURLToPath(new URL(".", pathToFileURL(args.path))) };
      });
    },
  }],
});
console.log(`Bundled test worker: ${outfile}`);
