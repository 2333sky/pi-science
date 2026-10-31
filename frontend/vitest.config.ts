import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import nodeEnvironmentFiles from "./vitest.node-env.json";

// Playwright specs live in tests/visual and must not run under vitest.
const baseExclude = [
  "**/node_modules/**",
  "**/dist/**",
  "**/cypress/**",
  "**/.{idea,git,cache,output,temp}/**",
  "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
  "**/tests/visual/**",
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    // Date/time form assertions must be reproducible outside UTC CI runners.
    env: { TZ: "UTC" },
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    exclude: baseExclude,
    // Constructing a jsdom environment costs ~1.3s per test file. Files under
    // src/lib that never touch a DOM global do not need one, so they run in the
    // node environment instead. vitest.node-env.json lists them explicitly
    // because the set is not a directory glob; regenerate it by grepping src/lib
    // for DOM globals and @testing-library imports. Anything that does touch the
    // DOM stays in the jsdom project, which inherits everything above.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: nodeEnvironmentFiles,
          exclude: baseExclude,
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          // The node project already collects these files; without this exclude
          // both projects collect them and the suite total silently doubles.
          exclude: [...baseExclude, ...nodeEnvironmentFiles],
        },
      },
    ],
  },
});
