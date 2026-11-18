import { randomUUID } from "node:crypto";
import type {
  EnvironmentBinding,
  EnvironmentOperation,
  EnvironmentResponse,
  WorkerEvent,
} from "./protocol.js";

export type RequestEnvironment = (
  operation: EnvironmentOperation,
  signal?: AbortSignal,
) => Promise<EnvironmentBinding | null>;

export class EnvironmentBridge {
  private readonly pending = new Map<string, (result: EnvironmentResponse["result"]) => void>();

  constructor(private readonly send: (event: WorkerEvent) => void) {}

  readonly request: RequestEnvironment = (operation, signal) => {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        this.send({ type: "environment_cancel", id });
        reject(signal?.reason ?? new Error("Environment request cancelled"));
      };
      this.pending.set(id, (result) => {
        cleanup();
        if ("error" in result) reject(new Error(result.error));
        else resolve(result.binding);
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.send({ type: "environment_request", id, operation });
      if (signal?.aborted) abort();
    });
  };

  receive({ id, result }: EnvironmentResponse): void {
    this.pending.get(id)?.(result);
  }
}
