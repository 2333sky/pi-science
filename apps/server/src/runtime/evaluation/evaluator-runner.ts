import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bindRuntimeReadPolicy } from "../sandbox/read-grants.js";
import { EvaluationBudgetError } from "../executions/execution-budget.js";
import { evaluatorPolicy } from "../sandbox/policy.js";
import { killSandboxGroup, launcherPath, prepareSandbox } from "../sandbox/process.js";
import { EvaluatorError, validateEvaluatorResult, validateSubmission, type EvaluatorRevision } from "./evaluator-contracts.js";
import { readEvaluatorFile } from "./evaluator-files.js";

export interface EvaluatorOutcome { status: "succeeded" | "failed" | "cancelled" | "timed_out"; exit_code: number | null; policy_id: string; metrics?: Record<string, number>; validity?: { passed: boolean; checks: string[] }; reason_code?: string }
/** No model-supplied paths/argv/env. The operator freezes main.py and bin/python3.
 * Candidate bytes are validated data, never imported or placed on Python's search path. */
export async function runEvaluator(stage: string, revision: EvaluatorRevision, bytes: Buffer, timeoutSeconds = revision.timeoutSeconds, signal?: AbortSignal): Promise<EvaluatorOutcome> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  validateSubmission(bytes, revision); signal?.throwIfAborted();
  await mkdir(join(stage, "submission"), { mode: 0o700 }); await mkdir(join(stage, "output"), { mode: 0o700 });
  await writeFile(join(stage, "submission/submission.json"), bytes, { flag: "wx", mode: 0o400 });
  const policy = await bindRuntimeReadPolicy(await evaluatorPolicy(stage, revision.environmentRevisionId));
  const prepared = await prepareSandbox(policy, [join(stage, "environment/bin/python3"), "-I", "-B", join(stage, "evaluator/main.py"), join(stage, "submission/submission.json"), join(stage, "dataset"), join(stage, "output/result.json")], [join(stage, "environment")], timeoutSeconds);
  try {
    if (signal?.aborted || Date.now() >= deadline) return { status: signal?.aborted ? "cancelled" : "timed_out", exit_code: null, policy_id: policy.id, reason_code: signal?.aborted ? "cancelled" : "timed_out" };
    const result = await new Promise<{ status: EvaluatorOutcome["status"]; exit_code: number | null; reason_code?: string }>((resolveRun) => {
      const child = spawn(process.execPath, [launcherPath, prepared.manifest], { cwd: policy.cwd, detached: true, shell: false, env: prepared.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let status: EvaluatorOutcome["status"] | undefined;
      const kill = () => killSandboxGroup(child.pid);
      // Limit aggregate private logs without retaining or forwarding their contents.
      let outputBytes = 0; let reasonCode: string | undefined;
      for (const stream of [child.stdout, child.stderr]) stream!.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 128 * 1024 && !status) { status = "failed"; reasonCode = "output_limit"; kill(); }
      });
      const abort = () => { status = "cancelled"; kill(); };
      const timer = setTimeout(() => { status = "timed_out"; kill(); }, Math.max(1, deadline - Date.now()));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); kill(); };
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      child.once("error", () => { cleanup(); resolveRun({ status: status ?? "failed", exit_code: null, reason_code: reasonCode }); });
      child.once("close", (code) => { cleanup(); resolveRun({ status: status ?? (code === 0 ? "succeeded" : "failed"), exit_code: code, reason_code: reasonCode }); });
    });
    if (result.status !== "succeeded") return { ...result, policy_id: policy.id, reason_code: result.reason_code ?? result.status };
    try {
      const raw = await readEvaluatorFile(join(stage, "output/result.json"), 64 * 1024);
      const validated = validateEvaluatorResult(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), revision);
      if (!validated.validity.passed) return { status: "failed", exit_code: result.exit_code, policy_id: policy.id, validity: validated.validity, reason_code: "invalid_result" };
      return { ...result, policy_id: policy.id, ...validated };
    } catch { return { status: "failed", exit_code: result.exit_code, policy_id: policy.id, reason_code: "invalid_result" }; }
  } finally { await prepared.cleanup(); }
}

export function safeEvaluationError(error: unknown): string { return error instanceof EvaluatorError || error instanceof EvaluationBudgetError ? error.code : "evaluation_unavailable"; }
