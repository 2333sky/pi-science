import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Compile the Agent Core worker entry once per run instead of letting every
    // forked session pay the ~1.1s tsx transform (see vitest.global-setup.ts).
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
