import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const { dnsLookup } = vi.hoisted(() => ({ dnsLookup: vi.fn(async () => {
  throw Object.assign(new Error("getaddrinfo ENOTFOUND: sandbox has no DNS"), { code: "ENOTFOUND" });
}) }));
vi.mock("node:dns/promises", () => ({ lookup: dnsLookup }));
vi.mock("../security/egress-audit.js", () => ({ egressAuditEnabled: async () => false }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks(); });

describe("MCP fetch without sandbox DNS", () => {
  it("uses the forced policy proxy even with NO_PROXY=*, without resolving the destination", async () => {
    const authorities: string[] = [];
    const sockets = new Set<Socket>();
    const proxy = createServer();
    proxy.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    proxy.on("connect", (request, socket) => {
      authorities.push(request.url!);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"));
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    vi.stubEnv("PI_SCIENCE_SANDBOX_HTTP_PROXY", `http://127.0.0.1:${(proxy.address() as { port: number }).port}`);
    vi.stubEnv("NO_PROXY", "*"); vi.stubEnv("no_proxy", "*");
    try {
      const { createMcpFetch } = await import("./runtime-fetch.js");
      const endpoint = "http://no-dns.invalid";
      const request = createMcpFetch({ connectorId: "sandbox", endpoint, allowPrivate: false });
      expect(await (await request(endpoint)).text()).toBe("ok");
      expect(authorities).toEqual(["no-dns.invalid:80"]);
      expect(dnsLookup).not.toHaveBeenCalled();
      await expect(request("http://other.invalid/")).rejects.toThrow("cross-origin");
      const privateRequest = createMcpFetch({ connectorId: "sandbox", endpoint: "http://127.0.0.1:1", allowPrivate: false });
      await expect(privateRequest("http://127.0.0.1:1")).rejects.toThrow("private or reserved");
      expect(authorities).toHaveLength(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => proxy.close(() => done()));
    }
  });

  it("keeps DNS-aware validation outside the sandbox", async () => {
    const { createMcpFetch } = await import("./runtime-fetch.js");
    const request = createMcpFetch({ connectorId: "host", endpoint: "https://no-dns.invalid", allowPrivate: false });
    await expect(request("https://no-dns.invalid")).rejects.toThrow("ENOTFOUND");
    expect(dnsLookup).toHaveBeenCalled();
  });

  it.each(["http://localhost:1234", "https://127.0.0.1:1234", "http://127.0.0.1:1234/path", "http://user:pass@127.0.0.1:1234"])("fails closed for an invalid sandbox proxy: %s", async (proxy) => {
    vi.stubEnv("PI_SCIENCE_SANDBOX_HTTP_PROXY", proxy);
    await expect(import("./runtime-fetch.js")).rejects.toThrow();
  });
});
