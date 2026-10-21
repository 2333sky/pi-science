import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NativeModelSettings } from "./NativeModelSettings";
import i18n from "../../../i18n";

beforeAll(async () => { await i18n.changeLanguage("en"); });
afterEach(() => vi.unstubAllGlobals());
const snapshot = { backend: "pi_ai_v1", revision: 3, config: { providers: { lab: { api: "openai-completions", baseUrl: "http://localhost:1234/v1", models: [{ id: "test", contextWindow: 8192, reasoning: true }], headers: { "accept": "application/json" } } } },
  schema_version: 1, credential_refs: { lab: "credential-id" }, keyless_providers: [], legacy_providers: [], aliases: {}, providers: [] };
function setup(conflict = false, unresolved = false, mergeable = false) {
  let readRevision = 3;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, method, body });
    let status = 200;
    let data: unknown = { ok: true, runtime: "published" };
    if (url === "/api/model-config" && method === "GET") data = { ...snapshot, revision: readRevision };
    if (url === "/api/model-config/preview" && conflict) readRevision = 4;
    if (url === "/api/model-config/catalog") data = { revision: 3, providers: [{ id: "lab", name: "Lab", editable: true, legacy: false, revision: 3, configured: true, source: "user", auth_capabilities: { api_key: true, environment: true, keyless: true, subscription: false }, allowed_actions: ["details", "credential", "edit", "disconnect", ...(mergeable ? ["refresh"] : [])], config: snapshot.config.providers.lab,
      authentication: { source: "environment", resolved: !unresolved, environment_variable: "LAB_KEY", restart_required: true },
      models: [{ id: "test", name: "Test", available: !unresolved, contextWindow: 8192, source: "configured" }] }, { id: "untouched", name: "Untouched", configured: false, source: "builtin", editable: true, revision: 3, legacy: false, config: null, authentication: { source: "unconfigured", resolved: false }, auth_capabilities: { api_key: true, environment: true, keyless: false, subscription: false }, allowed_actions: ["credential", "details", "disconnect"], models: [] }] };
    if ((url === "/api/model-config" && method === "PUT" || url === "/api/model-config/providers" && method === "POST") && conflict) { status = 409; data = { error: "Configuration changed; reload before saving" }; }
    if (url === "/api/model-config/discover") data = { models: [{ id: "candidate" }], inference_verified: false };
    if (url === "/api/model-config/providers/lab/discover") data = { models: [{ id: "test", display_name: "Test", capabilities: { context_window: 1000000, max_output_tokens: 65536, reasoning: true } }, { id: "new-model", display_name: "New Model" }] };
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><NativeModelSettings /></QueryClientProvider>);
  return requests;
}

describe("native model Settings", () => {
  it("shows explicit environment source and restart/inference boundaries", async () => {
    setup();
    expect(await screen.findByText(/Environment: LAB_KEY/)).toBeInTheDocument();
    expect(screen.getByText(/Worker reload does not reload OS variables/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Lab" }));
    expect(await screen.findByRole("columnheader", { name: "Model" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "8K" })).toBeInTheDocument();
    expect(screen.queryByText(/Inference not verified/)).not.toBeInTheDocument();
  });
  it("states availability only for models that are actually unavailable", async () => {
    setup(false, true);
    fireEvent.click(await screen.findByRole("button", { name: "Lab" }));
    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("0 / 1 available")).toBeInTheDocument();
  });
  it("rewrites capabilities on existing models and appends new ones during a refresh", async () => {
    const requests = setup(false, false, true);
    await screen.findByRole("button", { name: "Lab" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(await screen.findByText("Refreshed · 1 added · 1 updated")).toBeInTheDocument();
    expect(requests.find((request) => request.method === "PATCH")?.body).toMatchObject({ revision: 3, config: { models: [
      { id: "test", contextWindow: 1000000, maxTokens: 65536, reasoning: true },
      { id: "new-model", name: "New Model" },
    ] } });
  });
  it("re-reads the catalog on demand", async () => {
    const requests = setup();
    await screen.findByRole("button", { name: "Lab" });
    const before = requests.filter((request) => request.url === "/api/model-config/catalog").length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(await screen.findByText("Model list refreshed.")).toBeInTheDocument();
    expect(requests.filter((request) => request.url === "/api/model-config/catalog").length).toBeGreaterThan(before);
  });
});

async function openMenu() {
  fireEvent.pointerDown(await screen.findByRole("button", { name: "Lab actions" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
}
it("shows only configured services, starts collapsed, and exposes credentials solely in the menu", async () => {
  setup();
  expect(await screen.findByRole("button", { name: "Lab" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "Untouched" })).not.toBeInTheDocument();
  expect(screen.queryByText("Manage credentials")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Lab" }));
  expect(screen.queryByText("Manage credentials")).not.toBeInTheDocument();
  await openMenu();
  expect(await screen.findByRole("menuitem", { name: "Manage credentials" })).toBeInTheDocument();
});
it("keeps the custom API entry visible for empty searches and discards sensitive drafts before changing tabs", async () => {
  setup(); await screen.findByRole("button", { name: "Lab" });
  fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search providers" }), { target: { value: "no match" } });
  expect(screen.getByRole("button", { name: "Custom API" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Search providers" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /Untouched/ }));
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "unsaved-secret" } });
  fireEvent.click(screen.getByRole("tab", { name: "Subscription" }));
  expect(screen.getByRole("tab", { name: "API" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.getByText("Subscription authorization is not available yet")).toBeInTheDocument();
  expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "API" }));
  expect(screen.getByLabelText("API key")).toHaveValue("");
});
it("retains a custom API draft after conflict and never retries the sensitive write", async () => {
  const requests = setup(true); await screen.findByRole("button", { name: "Lab" });
  fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
  fireEvent.click(screen.getByRole("button", { name: "Custom API" }));
  for (const [label, value] of [["Provider name", "New Lab"], ["API key", "retained-secret"]]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: "http://localhost:1234/v1" } });
  fireEvent.change(screen.getByLabelText(/Manual model IDs/), { target: { value: "manual-model" } });
  fireEvent.submit(screen.getByLabelText("API key").closest("form")!);
  expect(await screen.findByRole("alert")).toHaveTextContent("Configuration changed");
  expect(screen.getByLabelText("API key")).toHaveValue("retained-secret");
  const writes = requests.filter((r) => r.url === "/api/model-config/providers");
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toHaveProperty("id", expect.stringMatching(/^custom-[0-9a-f-]{36}$/));
  expect(screen.queryByLabelText("Provider ID")).not.toBeInTheDocument();
  expect(writes[0].body).toMatchObject({ revision: 3, credential: { source: "managed", secret: "retained-secret" }, config: { models: [{ id: "manual-model" }] } });
});
it("edits a custom connection while preserving model metadata and headers", async () => {
  const requests = setup(); await openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit connection" }));
  const dialog = screen.getByRole("dialog", { name: "Lab · Edit connection" });
  fireEvent.change(within(dialog).getByLabelText("Provider name"), { target: { value: "Renamed" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(requests.find((r) => r.method === "PATCH")?.body).toMatchObject({ revision: 3, config: { name: "Renamed", models: [{ id: "test", contextWindow: 8192, reasoning: true }], headers: { accept: "application/json" } } });
});

it("retains configured connections whose credentials no longer resolve", async () => {
  setup(false, true);
  expect(await screen.findByRole("button", { name: "Lab" })).toBeInTheDocument();
  expect(screen.getByText("Needs attention")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Untouched" })).not.toBeInTheDocument();
});
