import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/node";
import { authorizeKernelPolicy, workerKernelGrant } from "./kernel-authorization.js";
import { sandboxBashTool } from "../agent/worker/sandbox-bash.js";
import { notebookHarnessTools } from "../agent/worker/notebook-tools.js";
import { candidateReadTool, sandboxCandidate, type SandboxIdentity } from "../agent/worker/sandbox-tool.js";

it("denies unbound restricted reads, Bash and Notebook regardless of role name", async () => {
  const identity: SandboxIdentity = { cwd: "/workspace", sessionId: "child", delegatedAgent: "lab/optimizer", executionScope: "candidate" };
  const tools = [sandboxBashTool(identity), ...notebookHarnessTools(identity.cwd, identity.sessionId, identity)];
  const original = tools[0]!;
  tools.push(candidateReadTool({ ...original, name: "read" }, identity));
  for (const tool of tools) {
    await expect(tool.execute("call", {}, () => {}, {} as never, { operationId: "op" } as never, BACKGROUND_CONTEXT)).rejects.toThrow(/bound candidate|server-bound candidate/);
  }
  await expect(sandboxCandidate({ ...identity, delegatedAgent: undefined }, "op", "forged")).rejects.toThrow("not authorized");
  const grant = workerKernelGrant(identity, "op", "secret");
  await expect(authorizeKernelPolicy(identity.cwd, undefined, grant, "secret")).rejects.toThrow("bound candidate_id");
  await expect(authorizeKernelPolicy(identity.cwd, undefined, grant + "forged", "secret")).rejects.toThrow("Invalid kernel");
});

it("requires renewed scope binding for previously signed delegated grants", async () => {
  const { createHmac } = await import("node:crypto");
  const payload = Buffer.from(JSON.stringify({ cwd: "/workspace", sessionId: "child", budgetOperationId: "op", delegatedAgent: "lab/optimizer", expires: Date.now() + 60_000 })).toString("base64url");
  const signature = createHmac("sha256", "secret").update(payload).digest("base64url");
  await expect(authorizeKernelPolicy("/workspace", undefined, `${payload}.${signature}`, "secret")).rejects.toThrow("fresh scope binding");
});
