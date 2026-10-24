import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it("uses the configured environment proxy without NODE_USE_ENV_PROXY", async () => {
  const requests: string[] = [];
  const proxy = createServer((request, response) => { requests.push(request.url!); response.end("proxy-download"); });
  proxy.on("connect", (request, socket) => {
    requests.push(request.url!);
    socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); socket.end();
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const port = (proxy.address() as { port: number }).port;
  vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${port}`); vi.stubEnv("http_proxy", `http://127.0.0.1:${port}`);
  vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${port}`); vi.stubEnv("https_proxy", `http://127.0.0.1:${port}`);
  vi.stubEnv("NO_PROXY", ""); vi.stubEnv("no_proxy", ""); vi.stubEnv("NODE_USE_ENV_PROXY", "");
  try {
    const { operatorFetch } = await import("./operator-fetch.js");
    await expect(operatorFetch("https://download.invalid/file", { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    expect(requests).toEqual(["download.invalid:443"]);
  } finally { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); }
});
