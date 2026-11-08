import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { NomadClient } from "../../src/backend/client.js";

function setup(fetch: PluginFetch) {
  const upstream = vi.fn(fetch);
  return { upstream, client: new NomadClient({ fetch: upstream }, new URL("https://nomad.internal:4646/proxy/"), "private-token", "global") };
}

describe("bounded Nomad transport", () => {
  it("accepts empty successful writes but rejects malformed JSON", async () => {
    const { client } = setup(async () => new Response(null, { status: 204 }));
    expect(await client.request("/v1/namespace/test", "default", { method: "DELETE" })).toBeNull();
    const malformed = setup(async () => new Response("not-json"));
    await expect(malformed.client.request("/v1/jobs", "default")).rejects.toMatchObject({ status: 502 });
  });

  it("rejects oversized JSON instead of parsing a truncated resource", async () => {
    const { client } = setup(async () => new Response(JSON.stringify({ value: "x".repeat(4 * 1024 * 1024) })));
    await expect(client.request("/v1/job/test", "default")).rejects.toMatchObject({ status: 502 });
  });

  it("rejects scope overrides and malformed CSI secrets before sending credentials", async () => {
    const { client, upstream } = setup(async () => Response.json({}));
    await expect(client.request("/v1/jobs", "default", { query: { namespace: "other" } })).rejects.toMatchObject({ status: 400 });
    await expect(client.request("/v1/volumes", "default", { csiSecrets: { token: "value\r\nX-Injected: yes" } })).rejects.toMatchObject({ status: 400 });
    await expect(client.request("/outside", "default")).rejects.toMatchObject({ status: 400 });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not expose upstream credential bodies or transport exception details", async () => {
    const { client } = setup(async () => new Response("private-token upstream-secret", { status: 500 }));
    const error = await client.request("/v1/jobs", "default").catch(value => value as Error);
    expect(String(error)).not.toContain("private-token");
    expect(String(error)).not.toContain("upstream-secret");
    const failed = setup(async () => { throw new Error("private-token internal-stack"); });
    const transportError = await failed.client.request("/v1/jobs", "default").catch(value => value as Error);
    expect(String(transportError)).not.toContain("private-token");
    expect(String(transportError)).not.toContain("internal-stack");
  });

  it("opens exec against the pinned resolved address", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string") throw new Error("Expected TCP address");
    const ctx = { fetch: vi.fn(), capabilities: { require: vi.fn(async () => {}) } } as unknown as PluginContext;
    const client = new NomadClient(ctx, new URL(`http://localhost:${address.port}`), "", "global");
    try {
      const socket = await client.socket(ctx, "/v1/client/allocation/test/exec", "default");
      expect(socket.readyState).toBe(1);
      socket.terminate();
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
