import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { once, EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PluginContext, PluginFetch, PluginWebSocketHandler } from "@termix-ssh/plugin-sdk/backend";
import WebSocket from "ws";
import { registerAllocationRoutes, allocationPath } from "../../src/backend/allocation-routes.js";
import { execCommand, execInput, registerAllocationSockets } from "../../src/backend/allocation-sockets.js";
import { NomadClient } from "../../src/backend/client.js";

const servers: Server[] = [];
const sockets: FakeSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.emit("close");
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(async server => { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; }));
});
function context(options: { permission?: string; namespace?: string; connect?: boolean; fetch?: PluginFetch } = {}) {
  const upstream = vi.fn<PluginFetch>(options.fetch || (async url => new URL(url).pathname === "/v1/allocation/alloc" ? Response.json({ ID: "alloc", Namespace: options.namespace || "team", TaskStates: { web: {} } }) : Response.json({})));
  const getHost = vi.fn(async () => ({ id: 7, ip: "10.0.0.7" }));
  const values: Record<string, unknown> = { enableNomad: true, address: "https://nomad.internal:4646", token: "never-expose-token", region: "global" };
  const ctx = {
    fetch: upstream, currentActor: () => "user", hosts: { get: getHost, checkAccess: async () => ({ hasAccess: options.connect !== false }) },
    settings: { getHost: async (_id: number, key: string) => values[key] },
    rbac: { has: async (permission: string) => permission !== options.permission, hasFor: async (_user: string, permission: string) => permission !== options.permission },
  } as unknown as PluginContext;
  return { ctx, upstream, getHost };
}
async function setup(options: Parameters<typeof context>[0] = {}) {
  const fixture = context(options);
  const app = express(); app.use(express.json()); registerAllocationRoutes(app, fixture.ctx);
  const server = app.listen(0, "127.0.0.1"); servers.push(server); await once(server, "listening");
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hosts/7/allocations`;
  return { ...fixture, request: (suffix: string, method = "GET", body?: unknown) => fetch(`${root}${suffix}${suffix.includes("?") ? "&" : "?"}namespace=team`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
}
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: unknown[] = [];
  closeCode: number | undefined;
  closeReason = "";
  close(code?: number, reason?: string) { this.readyState = WebSocket.CLOSED; this.closeCode = code; this.closeReason = reason || ""; this.emit("close"); }
  terminate() { this.close(); }
  send(value: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(value)); callback?.(); }
  pause() {}
  resume() {}
}
async function terminal(options: Parameters<typeof context>[0] = {}, query: Record<string, string> = {}) {
  const fixture = context(options);
  let handler: PluginWebSocketHandler | undefined;
  Object.assign(fixture.ctx, { ws: { route: (_path: string, callback: PluginWebSocketHandler) => { handler = callback; } } });
  registerAllocationSockets(fixture.ctx);
  const browser = new FakeSocket(); sockets.push(browser);
  const outbound = new FakeSocket();
  const connect = vi.spyOn(NomadClient.prototype, "socket").mockResolvedValue(outbound as unknown as WebSocket);
  const params = new URLSearchParams({ hostId: "7", namespace: "team", allocationId: "alloc", task: "web", command: '["/bin/sh"]', ...query });
  let unlocked = true;
  await handler!({ socket: browser, request: { url: `/allocations/exec?${params}` }, userId: "user", clientIp: "127.0.0.1", requestOrigin: "https://termix", isDataUnlocked: () => unlocked } as unknown as Parameters<PluginWebSocketHandler>[0]);
  return { ...fixture, browser, outbound, connect, lock: () => { unlocked = false; } };
}

describe("Allocation HTTP trust boundaries", () => {
  it("requires use and manage separately, before host credentials", async () => {
    const denied = await setup({ permission: "use" });
    expect((await denied.request("/alloc/restart", "POST", { task: "web" })).status).toBe(403);
    expect(denied.getHost).not.toHaveBeenCalled();
    const readOnly = await setup({ permission: "manage" });
    expect((await readOnly.request("/alloc/restart", "POST", { task: "web" })).status).toBe(403);
    expect(readOnly.upstream).not.toHaveBeenCalled();
  });
  it("verifies namespace, allocation ID and task before mutation and filesystem access", async () => {
    const mismatch = await setup({ namespace: "private" });
    expect((await mismatch.request("/alloc/fs/ls")).status).toBe(409);
    expect(mismatch.upstream).toHaveBeenCalledTimes(1);
    const fixture = await setup();
    expect((await fixture.request("/alloc/restart", "POST", { task: "other" })).status).toBe(400);
    expect((await fixture.request("/alloc/logs/stream?task=other&type=stdout")).status).toBe(400);
    expect(fixture.upstream.mock.calls.every(([url]) => new URL(url).pathname === "/v1/allocation/alloc")).toBe(true);
  });
  it("sends SDK restart one/all and stop payloads, not caller-selected URLs", async () => {
    const fixture = await setup();
    expect((await fixture.request("/alloc/restart", "POST", { task: "web", url: "http://evil" })).status).toBe(200);
    expect(JSON.parse(fixture.upstream.mock.calls[1]![1]!.body!)).toEqual({ TaskName: "web", AllTasks: false });
    expect((await fixture.request("/alloc/restart", "POST", { allTasks: true })).status).toBe(200);
    expect(JSON.parse(fixture.upstream.mock.calls[3]![1]!.body!)).toEqual({ TaskName: "", AllTasks: true });
    expect((await fixture.request("/alloc/stop", "POST")).status).toBe(200);
    expect(new URL(fixture.upstream.mock.calls[5]![0]).pathname).toBe("/v1/allocation/alloc/stop");
    expect(fixture.upstream.mock.calls.every(([url]) => new URL(url).hostname === "nomad.internal")).toBe(true);
  });
  it("uses finite plain end-origin logs and bounds file reads", async () => {
    const fixture = await setup({ fetch: async url => new URL(url).pathname === "/v1/allocation/alloc" ? Response.json({ ID: "alloc", Namespace: "team", TaskStates: { web: {} } }) : new Response("hello") });
    expect(await (await fixture.request("/alloc/logs?task=web&type=stderr")).json()).toEqual({ text: "hello" });
    expect(Object.fromEntries(new URL(fixture.upstream.mock.calls[1]![0]).searchParams)).toMatchObject({ type: "stderr", follow: "false", plain: "true", origin: "end", offset: "65536" });
    expect((await fixture.request("/alloc/fs/read?path=web/local/config&limit=0")).status).toBe(400);
    expect((await fixture.request("/alloc/fs/read?path=web/local/config&limit=65537")).status).toBe(400);
    expect(await (await fixture.request("/alloc/fs/read?path=web/local/config&offset=5")).json()).toEqual({ text: "hello" });
    expect(new URL(fixture.upstream.mock.calls.at(-1)![0]).pathname).toBe("/v1/client/fs/readat/alloc");
  });
  it("preserves binary download bytes and sends attachment headers", async () => {
    const bytes = new Uint8Array([0, 255, 127, 13, 10]);
    const fixture = await setup({ fetch: async url => {
      const path = new URL(url).pathname;
      if (path === "/v1/allocation/alloc") return Response.json({ ID: "alloc", Namespace: "team" });
      if (path.includes("/stat/")) return Response.json({ IsDir: false, Size: bytes.length });
      return new Response(bytes);
    } });
    const response = await fixture.request("/alloc/fs/download?path=web/local/a.bin");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="a.bin"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
  it("rejects paths escaping the allocation and unbounded shell commands", () => {
    for (const value of ["../secret", "web/../../secret", "/etc/passwd", "web\\secret", "a\0b"]) expect(() => allocationPath(value)).toThrow();
    expect(allocationPath("web/local/config")).toBe("web/local/config");
    for (const value of ['"sh"', "[]", '[null]', '["sh\\u0000"]', JSON.stringify(["x".repeat(9000)])]) expect(() => execCommand(value)).toThrow();
    expect(execCommand('["/bin/sh","-c","echo hello"]')).toEqual(["/bin/sh", "-c", "echo hello"]);
  });
});

describe("Authenticated allocation exec protocol", () => {
  it("requires both use and exec before reading host settings or opening sockets", async () => {
    for (const permission of ["use", "exec"]) {
      const fixture = await terminal({ permission });
      expect(fixture.browser.closeCode).toBe(1008);
      expect(fixture.getHost).not.toHaveBeenCalled();
      expect(fixture.connect).not.toHaveBeenCalled();
      fixture.connect.mockRestore();
    }
  });
  it("refuses foreign namespaces/tasks and connect-denied hosts", async () => {
    for (const [options, query] of [[{ namespace: "private" }, {}], [{}, { task: "other" }], [{ connect: false }, {}]] as const) {
      const fixture = await terminal(options, query);
      expect(fixture.browser.closeCode).toBe(1008);
      expect(fixture.connect).not.toHaveBeenCalled(); fixture.connect.mockRestore();
    }
  });
  it("negotiates real Nomad exec query, forwards base64 stdin/resize and sanitizes output", async () => {
    const fixture = await terminal();
    expect(fixture.connect).toHaveBeenCalledWith(fixture.ctx, "/v1/client/allocation/alloc/exec", "team", { task: "web", command: '["/bin/sh"]', tty: "true" });
    expect(fixture.browser.sent).toEqual([{ ready: true }]);
    fixture.browser.emit("message", Buffer.from('{"stdin":{"data":"aGVsbG8="}}'), false);
    fixture.browser.emit("message", Buffer.from('{"tty_size":{"width":80,"height":24}}'), false);
    expect(fixture.outbound.sent).toEqual([{ stdin: { data: "aGVsbG8=" } }, { tty_size: { width: 80, height: 24 } }]);
    fixture.outbound.emit("message", Buffer.from('{"stdout":{"data":"b2s="},"token":"never-expose-token"}'), false);
    expect(fixture.browser.sent.at(-1)).toEqual({ stdout: { data: "b2s=" } });
    fixture.outbound.emit("message", Buffer.from('{"exited":true,"result":{"exit_code":3}}'), false);
    expect(fixture.browser.sent.at(-1)).toEqual({ exited: true, result: { exit_code: 3 } });
    expect(fixture.browser.readyState).toBe(WebSocket.CLOSED);
  });
  it("decodes Nomad's omitted zero exit code as a successful command", async () => {
    const fixture = await terminal();
    fixture.outbound.emit("message", Buffer.from('{"exited":true,"result":{}}'), false);
    expect(fixture.browser.sent.at(-1)).toEqual({ exited: true, result: { exit_code: 0 } });
    expect(fixture.browser.closeCode).toBe(1000);
  });
  it.each([null, "invalid", [], { exit_code: null }])("rejects malformed Nomad exit results %j", async result => {
    const fixture = await terminal();
    fixture.outbound.emit("message", Buffer.from(JSON.stringify({ exited: true, result })), false);
    expect(fixture.browser.closeCode).toBe(1011);
    expect(fixture.browser.sent).not.toContainEqual(expect.objectContaining({ exited: true }));
  });
  it("closes congested or expired sessions and refuses malformed input", async () => {
    expect(() => execInput({ stdin: { data: "not base64!" } })).toThrow();
    expect(() => execInput({ tty_size: { width: 0, height: 24 } })).toThrow();
    expect(() => execInput({ stdin: { close: true }, tty_size: { width: 80, height: 24 } })).toThrow();
    const congested = await terminal(); congested.outbound.bufferedAmount = 1024 * 1024 + 1;
    congested.browser.emit("message", Buffer.from('{"stdin":{"data":"YQ=="}}'), false);
    expect(congested.browser.closeCode).toBe(1009); congested.connect.mockRestore();
    const expired = await terminal(); expired.lock();
    expired.browser.emit("message", Buffer.from('{"stdin":{"data":"YQ=="}}'), false);
    expect(expired.browser.closeReason).toBe("Session expired");
    expect(expired.outbound.readyState).toBe(WebSocket.CLOSED);
  });
  it("revalidates access, expires idle sessions, and cancels upstream when the client leaves", async () => {
    vi.useFakeTimers();
    const revoked = await terminal();
    vi.spyOn(revoked.ctx.rbac, "hasFor").mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(revoked.browser.closeReason).toBe("Terminal access revoked");
    expect(revoked.outbound.readyState).toBe(WebSocket.CLOSED);
    vi.restoreAllMocks();
    const idle = await terminal();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(idle.browser.closeReason).toBe("Terminal session reached its 30 minute limit");
    expect(idle.outbound.readyState).toBe(WebSocket.CLOSED);
    idle.connect.mockRestore();
    const cancelled = await terminal();
    cancelled.browser.close();
    expect(cancelled.outbound.readyState).toBe(WebSocket.CLOSED);
  });
});
