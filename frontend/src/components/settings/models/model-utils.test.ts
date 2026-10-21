import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_CONTEXT_WINDOW } from "@pi-science/contracts";
import { providerViewsFixture } from "../../../../tests/fixtures/provider-views";
import { buildServices, mergeDiscoveredModels, modelConfigFromDiscovery } from "./model-utils";

const fixture = providerViewsFixture({ providers: [{ id: "user-lab", name: "Lab", custom: true, has_key: false, models: ["model-a"], credential_status: "needs_key" }], available_models: [], custom_providers: [] }).providers[0];
describe("ProviderView presentation", () => {
  it.each(["ready", "needs_key", "invalid", "needs_login", "unavailable", "disabled"] as const)("preserves the server's %s status and configured models", (status) => {
    const service = buildServices([{ ...fixture, status }])[0];
    expect(service.status).toBe(status);
    expect(service.models).toHaveLength(1);
    expect(service.models[0]).toMatchObject({ available: false, contextWindow: null, maxOutputTokens: null, reason: "missing_credential" });
  });
  it("does not override Core availability using credential state", () => {
    const service = buildServices([{ ...fixture, status: "ready", models: [{ ...fixture.models[0], available: true }] }])[0];
    expect(service.models[0].available).toBe(true);
    expect(service.view.credential.configured).toBe(false);
  });
  it("does not fabricate input formats from vision capability", () => {
    const service = buildServices([{ ...fixture, models: [{ ...fixture.models[0], input_formats: undefined, capabilities: { ...fixture.models[0].capabilities, vision: true } }] }])[0];
    expect(service.models[0].inputFormats).toEqual([]);
  });

});

describe("discovered capabilities to stored configuration", () => {
  it("stores the shared context window when the provider declares none", () => {
    expect(modelConfigFromDiscovery({ id: "m" })).toEqual({ contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW });
  });
  it("keeps an undeclared output limit and a manual model id absent", () => {
    expect(modelConfigFromDiscovery({ id: "m", capabilities: { context_window: 8192 } })).not.toHaveProperty("maxTokens");
    expect(modelConfigFromDiscovery(undefined)).toEqual({});
  });
  it("maps the extended thinking levels for a reasoning model", () => {
    expect(modelConfigFromDiscovery({ id: "m", capabilities: { reasoning: true } })).toEqual({ contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW, reasoning: true, thinkingLevelMap: { xhigh: "high", max: "high" } });
  });
  it("never maps thinking levels for a non-reasoning model", () => {
    expect(modelConfigFromDiscovery({ id: "m", capabilities: { reasoning: false } })).not.toHaveProperty("thinkingLevelMap");
  });
  it("lets a row edit override the declared context window and capabilities", () => {
    expect(modelConfigFromDiscovery({ id: "m", capabilities: { context_window: 8192, max_output_tokens: 4096, reasoning: true, vision: true } }, { contextWindow: 200000, maxTokens: 32000, input: ["text"], reasoning: false }))
      .toEqual({ contextWindow: 200000, maxTokens: 32000, reasoning: false, input: ["text"] });
  });
  it("applies the same rule to the refresh merge", () => {
    expect(mergeDiscoveredModels([{ id: "known", contextWindow: 4096 }], [{ id: "known", capabilities: { context_window: 8192 } }, { id: "new" }])).toEqual({
      models: [{ id: "known", contextWindow: 8192 }, { id: "new", contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW }], added: 1, updated: 1,
    });
  });
});
