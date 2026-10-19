import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/node";
import { workerEventSchema } from "./protocol.js";
import { InteractionBridge } from "./interaction-bridge.js";
import { networkAccessTool } from "./network-access-tool.js";
import { changeNetworkGrant, readNetworkGrants, revokeNetworkGrant } from "../../sandbox/network-grants.js";
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "network-approval-"))); vi.stubEnv("PI_SCIENCE_HOME", root); vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", ""); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
function request(domain = "api.example.org", profile: "analysis" | "mcp" = "analysis") {
  const events: Array<Record<string, unknown>> = [];
  const bridge = new InteractionBridge((event) => events.push(event));
  const tool = networkAccessTool(bridge);
  const run = (signal?: AbortSignal) => tool.execute("request", { domain, profile, reason: "Download study data" }, () => {}, {} as never, {} as never, { ...BACKGROUND_CONTEXT, abortSignal: signal });
  return { events, bridge, run };
}
it("only saves a persistent grant after explicit approval and avoids reprompting after recreation", async () => {
  const { events, bridge, run } = request(); const result = run();
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(workerEventSchema.safeParse({ type: "runtime_event", event: { ...events[0], runtime_epoch: "network-test", runtime_sequence: 1 } }).success).toBe(true);
  expect(events[0]).toMatchObject({ type: "interaction.requested", method: "select", kind: "permission", message: expect.stringContaining("across all projects") });
  expect((await readNetworkGrants()).rules).toHaveLength(0);
  bridge.notify("extension_ui_response", { id: events[0]!.id, value: "allow" });
  expect(await result).toMatchObject({ details: { status: "granted" } });
  const restored = request(); expect(await restored.run()).toMatchObject({ details: { status: "already_allowed" } }); expect(restored.events).toHaveLength(0);
});
it.each(["deny_once", "deny"])("handles %s without granting network access", async (answer) => {
  const { events, bridge, run } = request(); const result = run();
  await vi.waitFor(() => expect(events).toHaveLength(1));
  bridge.notify("extension_ui_response", { id: events[0]!.id, value: answer });
  expect(await result).toMatchObject({ details: { status: "denied" } });
  expect((await readNetworkGrants()).rules).toHaveLength(answer === "deny" ? 1 : 0);
  if (answer === "deny") { const next = request(); expect(await next.run()).toMatchObject({ details: { status: "denied" } }); expect(next.events).toHaveLength(0); }
});
it("cannot replace a newer denial with an old approval", async () => {
  const { events, bridge, run } = request(); const result = run();
  const failure = expect(result).rejects.toThrow("changed while approval");
  await vi.waitFor(() => expect(events).toHaveLength(1));
  await changeNetworkGrant({ profile: "analysis", domain: "api.example.org", decision: "deny" }, "settings");
  bridge.notify("extension_ui_response", { id: events[0]!.id, value: "allow" }); await failure;
});
it("cancels a pending approval without saving a decision", async () => {
  const { events, run } = request(); const controller = new AbortController(); const result = run(controller.signal);
  const failure = expect(result).rejects.toThrow();
  await vi.waitFor(() => expect(events).toHaveLength(1)); controller.abort(); await failure;
  expect((await readNetworkGrants()).rules).toHaveLength(0);
});

it("accepts all parallel approvals for different domains and profiles without reprompting", async () => {
  const requests = [request("a.example.org"), request("b.example.org"), request("a.example.org", "mcp")];
  const results = requests.map((item) => item.run());
  await vi.waitFor(() => { for (const item of requests) expect(item.events).toHaveLength(1); });
  for (let i = 0; i < requests.length; i++) {
    requests[i]!.bridge.notify("extension_ui_response", { id: requests[i]!.events[0]!.id, value: "allow" });
    expect(await results[i]).toMatchObject({ details: { status: "granted" } });
  }
  expect((await readNetworkGrants()).rules).toHaveLength(3);
});
it("rejects an old approval even if the same target was allowed then revoked", async () => {
  const { events, bridge, run } = request();
  const result = run();
  const failure = expect(result).rejects.toThrow("changed while approval");
  await vi.waitFor(() => expect(events).toHaveLength(1));
  await changeNetworkGrant({ domain: "api.example.org", profile: "analysis", decision: "allow" }, "settings");
  await revokeNetworkGrant("analysis", "api.example.org");
  bridge.notify("extension_ui_response", { id: events[0]!.id, value: "allow" });
  await failure;
  expect((await readNetworkGrants()).rules).toHaveLength(0);
});
