import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/node";
import { authorizeKernelPolicy, workerKernelGrant } from "./kernel-authorization.js";
import { sandboxBashTool } from "../agent/worker/sandbox-bash.js";
import { notebookHarnessTools } from "../agent/worker/notebook-tools.js";
import { sandboxCandidate } from "../../skill-adapters/legacy-auto-research.js";
import { confinedReadTool, type SandboxIdentity } from "../agent/worker/confined-read-tool.js";

it("denies unbound restricted reads, Bash and Notebook regardless of role name", async () => {
  const identity: SandboxIdentity = { cwd: "/workspace", sessionId: "child", delegatedAgent: "lab/optimizer", executionScope: "candidate" };
  const tools = [sandboxBashTool(identity), ...notebookHarnessTools(identity.cwd, identity.sessionId, identity)];
  const original = tools[0]!;
  tools.push(confinedReadTool({ ...original, name: "read" }, identity));
  for (const tool of tools) {
    await expect(tool.execute("call", {}, () => {}, {} as never, { operationId: "op" } as never, BACKGROUND_CONTEXT)).rejects.toThrow(/bound candidate|server-bound candidate/);
  }
  await expect(sandboxCandidate({ ...identity, delegatedAgent: undefined }, "op", "forged")).rejects.toThrow("not authorized");
  const grant = await workerKernelGrant(identity, "op", "secret");
  await expect(authorizeKernelPolicy(identity.cwd, undefined, grant, "secret")).rejects.toThrow("bound candidate_id");
  await expect(authorizeKernelPolicy(identity.cwd, undefined, grant + "forged", "secret")).rejects.toThrow("Invalid kernel");
});

it("requires renewed scope binding for previously signed delegated grants", async () => {
  const { createHmac } = await import("node:crypto");
  const payload = Buffer.from(JSON.stringify({ cwd: "/workspace", sessionId: "child", budgetOperationId: "op", delegatedAgent: "lab/optimizer", expires: Date.now() + 60_000 })).toString("base64url");
  const signature = createHmac("sha256", "secret").update(payload).digest("base64url");
  await expect(authorizeKernelPolicy("/workspace", undefined, `${payload}.${signature}`, "secret")).rejects.toThrow("fresh scope binding");
});

it("invalidates signed root kernel leases after an approval revision change", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { vi } = await import("vitest");
  const cwd = await mkdtemp(join(tmpdir(), "kernel-epoch-"));
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "private")); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host");
  try {
    const { saveSessionApproval } = await import("./session-approval.js");
    await saveSessionApproval(cwd, "root", "full", 0);
    const grant = await workerKernelGrant({ cwd, sessionId: "root" }, "op", "secret");
    expect((await authorizeKernelPolicy(cwd, undefined, grant, "secret")).approval?.revision).toBe(1);
    await saveSessionApproval(cwd, "root", "ask", 1);
    await expect(authorizeKernelPolicy(cwd, undefined, grant, "secret")).rejects.toThrow("revision changed");
    const fresh = await workerKernelGrant({ cwd, sessionId: "root" }, "op2", "secret");
    expect((await authorizeKernelPolicy(cwd, undefined, fresh, "secret")).approval?.revision).toBe(2);
  } finally { vi.unstubAllEnvs(); await rm(cwd, { recursive: true, force: true }); }
});

it("rejects delayed signed kernel requests during the pre-commit revocation window", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { vi } = await import("vitest");
  const { beginApprovalTransition, finishApprovalTransition } = await import("./approval-transition.js");
  const cwd = await mkdtemp(join(tmpdir(), "kernel-transition-"));
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "private")); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host");
  try {
    const grant = await workerKernelGrant({ cwd, sessionId: "root" }, "op", "secret");
    beginApprovalTransition(cwd, "root");
    await expect(authorizeKernelPolicy(cwd, undefined, grant, "secret")).rejects.toThrow("blocks capability dispatch");
    finishApprovalTransition(cwd, "root");
    expect((await authorizeKernelPolicy(cwd, undefined, grant, "secret")).approval?.revision).toBe(0);
  } finally { finishApprovalTransition(cwd, "root"); vi.unstubAllEnvs(); await rm(cwd, { recursive: true, force: true }); }
});
