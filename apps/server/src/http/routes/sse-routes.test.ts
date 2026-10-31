import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationEventHub } from "../../runtime/events/conversation-event-hub.js";
import { resolveLastEventId, registerSseRoutes, SseBackpressureBuffer } from "./sse-routes.js";
import type { SseEventRecord } from "../../runtime/events/event-store.js";

describe("SSE backpressure buffer", () => {
  it("stays bounded by item count and byte size", () => {
    const buffer = new SseBackpressureBuffer(8, 2);
    expect(buffer.enqueue("1234")).toBe(true);
    expect(buffer.enqueue("5678")).toBe(true);
    expect(buffer.enqueue("x")).toBe(false);
    expect(buffer.length).toBe(2);
  });

  it("consumes the accepted item when the stream signals backpressure", () => {
    const buffer = new SseBackpressureBuffer(100, 10);
    buffer.enqueue("first");
    buffer.enqueue("second");
    const firstDrain: string[] = [];
    buffer.drain((text) => { firstDrain.push(text); return false; });
    expect(firstDrain).toEqual(["first"]);
    expect(buffer.length).toBe(1);
    const secondDrain: string[] = [];
    buffer.drain((text) => { secondDrain.push(text); return true; });
    expect(secondDrain).toEqual(["second"]);
    expect(buffer.length).toBe(0);
  });
});

describe("SSE cursor selection", () => {
  it("accepts an explicit query cursor for a newly-created EventSource", () => {
    expect(resolveLastEventId(undefined, "epoch:42")).toBe("epoch:42");
  });

  it("prefers the standard Last-Event-ID header on browser reconnect", () => {
    expect(resolveLastEventId("epoch:43", "epoch:42")).toBe("epoch:43");
  });
});

describe("SSE session existence fallback", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-science-sse-"));
  mkdirSync(join(workspace, ".pi-science", "sessions"), { recursive: true });

  it("accepts a session that exists only in the live in-memory runtime", async () => {
    const app = Fastify();
    const sessionService = {
      exists: async () => false,
      liveSessions: () => [{ id: "fresh-session", cwd: workspace }],
    };
    let subscribed = false;
    const hub = {
      subscribe: async () => {
        subscribed = true;
        throw new Error("subscribe-reached");
      },
    };
    registerSseRoutes(app, sessionService as never, hub as never);
    const response = await app.inject({ method: "GET", url: `/api/sessions/fresh-session/events?cwd=${encodeURIComponent(workspace)}` });
    // The existence fallback let the request through to subscription — the
    // route did NOT reply with the terminal "session not found" error.
    expect(subscribed).toBe(true);
    expect(response.body).not.toContain("session not found in this workspace");
    await app.close();
  });

  it("still rejects a session that is neither on disk nor in memory", async () => {
    const app = Fastify();
    const sessionService = {
      exists: async () => false,
      liveSessions: () => [],
    };
    const hub = { subscribe: async () => ({ unsubscribe: () => undefined }) };
    registerSseRoutes(app, sessionService as never, hub as never);
    const response = await app.inject({ method: "GET", url: `/api/sessions/ghost/events?cwd=${encodeURIComponent(workspace)}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("session not found in this workspace");
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});

function replayRecord(sessionId: string, sequence: number, padding = 0): SseEventRecord {
  return {
    event: "status.updated",
    id: `test-epoch:${sequence}`,
    data: JSON.stringify({ type: "status.updated", sessionId, seq: sequence, text: "x".repeat(padding) }),
    created_at: new Date(1_700_000_000_000 + sequence).toISOString(),
  };
}

function sessionServiceFor(cwd: string): { exists: () => Promise<boolean>; liveSessions: () => { id: string; cwd: string }[] } {
  return { exists: async () => true, liveSessions: () => [{ id: "sse-session", cwd }] };
}

function eventIds(body: string): string[] {
  return [...body.matchAll(/^id: (.+)$/gm)].map((match) => match[1] ?? "");
}

/** Read the response one chunk at a time: the replay must run while the
 *  consumer is slow, which is the only real-world path to an overflow. */
function readSlowly(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const request = httpGet(url, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        chunks.push(chunk);
        response.pause();
        setTimeout(() => response.resume(), 5);
      });
      response.on("end", () => resolve(chunks.join("")));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(15_000, () => request.destroy(new Error("SSE test request timed out")));
  });
}

describe("SSE replay pacing", () => {
  it("ends a replay past the buffer cap with an explicit stream.gap", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-science-sse-replay-"));
    mkdirSync(join(workspace, ".pi-science"), { recursive: true });
    const app = Fastify();
    const hub = {
      subscribe: async (
        _cwd: string,
        _sessionId: string,
        _cursor: string | undefined,
        deliver: (record: SseEventRecord) => unknown,
      ) => {
        for (let sequence = 1; sequence <= 700; sequence += 1) {
          if (deliver(replayRecord("sse-session", sequence, 1024)) === false) break;
        }
        return () => undefined;
      },
    };
    registerSseRoutes(app, sessionServiceFor(workspace) as never, hub as never);
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/sse-session/events?cwd=${encodeURIComponent(workspace)}`,
    });
    expect(response.body).toContain(": connected");
    // 700 records at 1KB exceed the 512KB replay buffer, so the stream must end
    // with a rebase hint instead of an unbounded in-memory backlog or a silent
    // truncation.
    const ids = eventIds(response.body);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(700);
    const gapIndex = response.body.indexOf("event: stream.gap");
    expect(gapIndex).toBeGreaterThan(-1);
    expect(response.body.slice(gapIndex)).toContain('"reason":"replay_overflow"');
    expect(response.body.slice(gapIndex)).not.toMatch(/^id: /m);
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("ends a replay that outruns a slow consumer with an id-less stream.gap", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-science-sse-overflow-"));
    mkdirSync(join(workspace, ".pi-science"), { recursive: true });
    const app = Fastify();
    const hub = {
      subscribe: async (
        _cwd: string,
        _sessionId: string,
        _cursor: string | undefined,
        deliver: (record: SseEventRecord) => unknown,
      ) => {
        for (let sequence = 1; sequence <= 700; sequence += 1) {
          if (deliver(replayRecord("sse-session", sequence, 32 * 1024)) === false) break;
        }
        return () => undefined;
      },
    };
    registerSseRoutes(app, sessionServiceFor(workspace) as never, hub as never);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const body = await readSlowly(`http://127.0.0.1:${port}/api/sessions/sse-session/events?cwd=${encodeURIComponent(workspace)}`);
    expect(body).toContain(": connected");
    expect(eventIds(body).length).toBeLessThan(700);
    const gapIndex = body.indexOf("event: stream.gap");
    expect(gapIndex).toBeGreaterThan(-1);
    const tail = body.slice(gapIndex);
    expect(tail).toContain('"reason":"replay_overflow"');
    // The gap must not consume a stream position.
    expect(tail).not.toMatch(/^id: /m);
    expect(body.endsWith("\n\n")).toBe(true);
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});

describe("SSE subscription abandonment", () => {
  it("closes the response with a gap when delivery abandons the subscriber", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-science-sse-abandon-"));
    mkdirSync(join(workspace, ".pi-science"), { recursive: true });
    const app = Fastify();
    const hub = {
      subscribe: async (
        _cwd: string,
        _sessionId: string,
        _cursor: string | undefined,
        _deliver: (record: SseEventRecord) => unknown,
        _replay: boolean,
        onAbandon: ((reason: string) => void) | undefined,
      ) => {
        onAbandon?.("delivery_failed");
        return () => undefined;
      },
    };
    registerSseRoutes(app, sessionServiceFor(workspace) as never, hub as never);
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/sse-session/events?cwd=${encodeURIComponent(workspace)}`,
    });
    expect(response.body).toContain(": connected");
    expect(response.body).toContain("event: stream.gap");
    expect(response.body).toContain('"reason":"subscriber_overflow"');
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("reports a replay backlog overflow from the real delivery path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-science-sse-backlog-"));
    mkdirSync(join(workspace, ".pi-science"), { recursive: true });
    const app = Fastify();
    let releaseReplay: () => void = () => undefined;
    const replayGate = new Promise<SseEventRecord[]>((resolve) => { releaseReplay = () => resolve([]); });
    const hub = new ConversationEventHub({
      append: async () => undefined,
      readAfter: () => replayGate,
    });
    registerSseRoutes(app, sessionServiceFor(workspace) as never, hub as never);
    // A cursor makes subscribe() await the replayed page; live records that
    // arrive inside that window pile up on the still-unready subscriber.
    const pendingResponse = app.inject({
      method: "GET",
      url: `/api/sessions/sse-session/events?cwd=${encodeURIComponent(workspace)}&lastEventId=test-epoch:0`,
    });
    while (!hub.hasSubscribers(workspace, "sse-session")) await new Promise((resolve) => setTimeout(resolve, 5));
    for (let sequence = 1; sequence <= 2_001; sequence += 1) {
      await hub.publish(workspace, "sse-session", { type: "status.updated", seq: sequence });
    }
    releaseReplay();
    const response = await pendingResponse;
    expect(response.body).toContain(": connected");
    expect(response.body).toContain("event: stream.gap");
    expect(response.body).toContain('"reason":"replay_overflow"');
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});
