import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWorkerEntry, workerEnvironment } from "./agent-runtime-client.js";

const override = "/tmp/pi-science-worker-entry-test/main.mjs";

describe("Agent Core worker entry", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses PI_SCIENCE_WORKER_ENTRY only while NODE_ENV is test", () => {
    expect(resolveWorkerEntry({ NODE_ENV: "test", PI_SCIENCE_WORKER_ENTRY: override })).toEqual({ path: override, execArgv: [] });
    for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "development" }, {}]) {
      const entry = resolveWorkerEntry({ ...env, PI_SCIENCE_WORKER_ENTRY: override });
      // Production and dev keep the compiled or tsx entry byte for byte: the
      // override is ignored, not merely deprioritised.
      expect(entry).toEqual(resolveWorkerEntry({}));
      expect(entry.path).not.toBe(override);
      expect(entry.execArgv).not.toContain(override);
    }
  });

  it("resolves the checkout entry when the override is absent", () => {
    expect(resolveWorkerEntry({ NODE_ENV: "test" })).toEqual(resolveWorkerEntry({}));
  });

  it("never forwards the override into the worker environment", () => {
    vi.stubEnv("PI_SCIENCE_WORKER_ENTRY", override);
    expect(workerEnvironment({}, [])).not.toHaveProperty("PI_SCIENCE_WORKER_ENTRY");
  });
});
