import { get as httpGet, type ClientRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { ConversationEventHub } from "../../runtime/events/conversation-event-hub.js";
import type { SseEventRecord } from "../../runtime/events/event-store.js";
import { registerSseRoutes } from "./sse-routes.js";

function timeout<T>(promise: Promise<T>, stage: string, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`SSE test timed out waiting for ${stage}`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function open(url: string): { request: ClientRequest; response: Promise<IncomingMessage> } {
  const request = httpGet(url);
  return {
    request,
    response: new Promise((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
    }),
  };
}

async function verifyAbandonedReplay(mode: "normal" | "symlink"): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-sse-fixture-"));
  const target = join(root, "target");
  mkdirSync(target);
  const tempPath = mode === "symlink" ? join(root, "alias") : target;
  if (mode === "symlink") symlinkSync(target, tempPath, "dir");
  // Match the route's async realpath: on Windows the synchronous version can
  // retain an 8.3 short path while the async version returns its long form.
  const workspace = await realpath(mkdtempSync(join(tempPath, "pi-sse-abandoned-")));
  mkdirSync(join(workspace, ".pi-science"));
  const app = Fastify();
  const records: SseEventRecord[] = [];
  let subscribedCwd = "";
  let releaseReplay: () => void = () => undefined;
  let replayStarted: () => void = () => undefined;
  let releaseResume: () => void = () => undefined;
  let resumeStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    replayStarted = resolve;
  });
  const gate = new Promise<SseEventRecord[]>((resolve) => {
    releaseReplay = () => resolve([]);
  });
  const startedResume = new Promise<void>((resolve) => {
    resumeStarted = resolve;
  });
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  let reads = 0;
  const hub = new ConversationEventHub({
    append: async (_cwd, _session, record) => {
      records.push(record);
    },
    readAfter: async (cwd) => {
      subscribedCwd = cwd;
      reads += 1;
      if (reads === 1) {
        replayStarted();
        return gate;
      }
      const snapshot = records.slice();
      resumeStarted();
      await resumeGate;
      return snapshot;
    },
  });
  registerSseRoutes(
    app,
    {
      exists: async () => true,
      liveSessions: () => [],
    } as never,
    hub,
  );
  let first: ClientRequest | undefined;
  let second: ClientRequest | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/sessions/session/events?cwd=${encodeURIComponent(workspace)}&lastEventId=epoch%3A0`;
    const initial = open(url);
    first = initial.request;
    const response = await timeout(initial.response, "initial response");
    expect(response.statusCode).toBe(200);
    const disconnected = new Promise<void>((resolve) => {
      response.once("end", resolve);
      response.once("aborted", resolve);
      response.once("close", resolve);
      response.once("error", resolve);
    });
    response.resume();
    await timeout(started, "initial replay");
    expect(
      hub.hasSubscribers(workspace, "session"),
      JSON.stringify({
        workspace,
        subscribedCwd,
        subscribed: hub.hasSubscribers(subscribedCwd, "session"),
      }),
    ).toBe(true);
    for (let sequence = 1; sequence <= 2_001; sequence += 1) {
      await hub.publish(workspace, "session", { type: "status.updated", sequence });
    }
    await timeout(disconnected, "abandoned connection to close");
    expect(hub.hasSubscribers(workspace, "session")).toBe(false);
    releaseReplay();

    const resumed = open(url);
    second = resumed.request;
    const replay = await timeout(resumed.response, "reconnect response");
    expect(replay.statusCode).toBe(200);
    await timeout(startedResume, "reconnect replay");
    expect(hub.hasSubscribers(workspace, "session")).toBe(true);
    for (let sequence = 2_002; sequence <= 2_006; sequence += 1) {
      await hub.publish(workspace, "session", { type: "status.updated", sequence });
    }
    releaseResume();
    const received = await timeout(
      new Promise<string>((resolve, reject) => {
        let body = "";
        replay.setEncoding("utf8");
        replay.on("data", (chunk: string) => {
          body += chunk;
          if (body.includes(`id: ${records.at(-1)!.id}\n`)) resolve(body);
        });
        replay.once("end", () => reject(new Error("replay ended early")));
        replay.once("error", reject);
      }),
      "replayed events",
      10_000,
    );
    const ids = [...received.matchAll(/^id: (.+)$/gm)].map((match) => match[1]);
    expect(ids).toEqual(records.map((record) => record.id));
  } finally {
    releaseReplay();
    releaseResume();
    first?.destroy();
    second?.destroy();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// Creating directory symlinks on Windows may require elevated privileges. The
// normal test still runs there and canonicalizes any existing temp alias.
it(
  "closes an abandoned socket and replays missed events",
  () => verifyAbandonedReplay("normal"),
  20_000,
);
it.skipIf(process.platform === "win32")(
  "handles a symlinked temp path",
  () => verifyAbandonedReplay("symlink"),
  20_000,
);
