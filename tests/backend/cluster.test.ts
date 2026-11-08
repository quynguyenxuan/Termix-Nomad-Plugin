import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { PluginContext, PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import { registerClusterRoutes } from "../../src/backend/cluster-routes.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed;
  }));
});
async function setup(options: { admin?: boolean; use?: boolean; actor?: boolean; connect?: boolean; upstream?: PluginFetch } = {}) {
  const upstream = vi.fn<PluginFetch>(options.upstream ?? (async () => Response.json({ ID: "node-1" })));
  const values: Record<string, unknown> = { enableNomad: true, address: "https://nomad.internal:4646", region: "global", token: "cluster-private-token" };
  const settings = vi.fn(async (_host: number, key: string) => values[key]);
  const host = vi.fn(async () => ({ id: 7, ip: "10.0.0.7" }));
  const ctx = {
    fetch: upstream, currentActor: () => options.actor === false ? null : "actor",
    hosts: { get: host, checkAccess: async () => ({ hasAccess: options.connect !== false }) }, settings: { getHost: settings },
    rbac: { has: async (permission: string) => permission === "administer" ? options.admin !== false : permission === "use" ? options.use !== false : true },
  } as unknown as PluginContext;
  const app = express(); app.use(express.json()); registerClusterRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1"); servers.push(server); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hosts/7`;
  const request = (path: string, method = "GET", body?: unknown) => fetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { upstream, settings, host, request };
}

describe("Nomad cluster trust boundaries", () => {
  it("requires admin before credential lookup for every global mutation and server diagnostic", async () => {
    const app = await setup({ admin: false });
    for (const [method, path] of [["PUT", "/nodes/node-1/drain"], ["PUT", "/nodes/node-1/eligibility"], ["PUT", "/node-pools"], ["DELETE", "/node-pools/team"], ["GET", "/servers"], ["GET", "/servers/raft"], ["GET", "/agent/self"], ["GET", "/agent/metrics"], ["GET", "/servers/server-1/monitor"], ["GET", "/nodes/node-1/monitor"]]) {
      expect((await app.request(path!, method!, method === "GET" ? undefined : {})).status).toBe(403);
    }
    expect(app.settings).not.toHaveBeenCalled(); expect(app.upstream).not.toHaveBeenCalled(); expect(app.host).not.toHaveBeenCalled();
  });
  it("requires an authenticated actor and host connect access for cluster reads", async () => {
    const anonymous = await setup({ actor: false });
    expect((await anonymous.request("/nodes")).status).toBe(401); expect(anonymous.host).not.toHaveBeenCalled();
    const denied = await setup({ connect: false });
    expect((await denied.request("/nodes")).status).toBe(403); expect(denied.settings).not.toHaveBeenCalled();
  });
  it("never exposes agent configuration secrets", async () => {
    const app = await setup({ upstream: async () => Response.json({ config: { ACL: { Tokens: { agent: "cluster-private-token" } } }, member: { Name: "server-1" }, stats: { raft: { state: "Leader" } } }) });
    const response = await app.request("/agent/self");
    expect(await response.json()).toEqual({ member: { Name: "server-1" }, stats: { raft: { state: "Leader" } } });
  });
  it("rejects mismatched node identities before drain and direct client stats", async () => {
    const app = await setup({ upstream: async () => Response.json({ ID: "another-node" }) });
    expect((await app.request("/nodes/node-1/drain", "PUT", { enabled: false, markEligible: true })).status).toBe(409);
    expect((await app.request("/nodes/node-1/stats")).status).toBe(409);
    expect((await app.request("/nodes/node-1/monitor")).status).toBe(409);
    expect(app.upstream).toHaveBeenCalledTimes(3);
  });
  it("rejects cross-namespace and cross-node allocation responses", async () => {
    const wrongNamespace = await setup({ upstream: async () => Response.json([{ ID: "a", NodeID: "node-1", Namespace: "private" }]) });
    expect((await wrongNamespace.request("/nodes/node-1/allocations?namespace=default")).status).toBe(409);
    const wrongNode = await setup({ upstream: async () => Response.json([{ ID: "a", NodeID: "node-2", Namespace: "default" }]) });
    expect((await wrongNode.request("/nodes/node-1/allocations")).status).toBe(409);
  });
});

describe("Nomad cluster wire protocol", () => {
  it("converts drain seconds to duration nanoseconds and explicitly cancels drain", async () => {
    const app = await setup();
    expect((await app.request("/nodes/node-1/drain", "PUT", { enabled: true, deadlineSeconds: 60, ignoreSystemJobs: true, markEligible: false })).status).toBe(200);
    const [url, init] = app.upstream.mock.calls[1]!;
    expect(new URL(url).pathname).toBe("/v1/node/node-1/drain");
    expect(JSON.parse(init!.body!)).toMatchObject({ NodeID: "node-1", DrainSpec: { Deadline: 60_000_000_000, IgnoreSystemJobs: true }, MarkEligible: false });
    expect((await app.request("/nodes/node-1/drain", "PUT", { enabled: false, markEligible: true })).status).toBe(200);
    expect(JSON.parse(app.upstream.mock.calls[3]![1]!.body!)).toMatchObject({ DrainSpec: null, MarkEligible: true });
  });
  it("rejects unsafe durations, non-boolean scheduling changes and nonmatching pool edits", async () => {
    const app = await setup();
    expect((await app.request("/nodes/node-1/drain", "PUT", { enabled: true, deadlineSeconds: 9_007_200, ignoreSystemJobs: false, markEligible: false })).status).toBe(400);
    expect((await app.request("/nodes/node-1/eligibility", "PUT", { eligible: "false" })).status).toBe(400);
    expect((await app.request("/node-pools/team", "PUT", { Name: "other", Description: "" })).status).toBe(400);
    expect(app.upstream).toHaveBeenCalledTimes(1);
  });
  it("sends eligibility using the official NodeID and Eligibility fields", async () => {
    const app = await setup();
    expect((await app.request("/nodes/node-1/eligibility", "PUT", { eligible: false })).status).toBe(200);
    expect(JSON.parse(app.upstream.mock.calls[1]![1]!.body!)).toEqual({ NodeID: "node-1", Eligibility: "ineligible" });
  });
  it("keeps pagination metadata and admits only the fixed resource query", async () => {
    const app = await setup({ upstream: async () => Response.json([{ ID: "node-1" }], { headers: { "X-Nomad-NextToken": "cursor-2" } }) });
    const result = await app.request("/nodes?per_page=12&next_token=cursor-1&resources=false&region=foreign&address=http://evil");
    expect(await result.json()).toEqual({ items: [{ ID: "node-1" }], nextToken: "cursor-2" });
    const url = new URL(app.upstream.mock.calls[0]![0]);
    expect(url.hostname).toBe("nomad.internal");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ namespace: "default", region: "global", per_page: "12", next_token: "cursor-1", resources: "true" });
    expect(url.searchParams.has("address")).toBe(false);
  });
  it("registers and updates node pools at the official plural endpoint without forwarding scope overrides", async () => {
    const app = await setup({ upstream: async () => new Response(null, { status: 204 }) });
    const pool = { Name: "team", Description: "Team clients", Meta: { owner: "platform" }, SchedulerConfiguration: { SchedulerAlgorithm: "spread", MemoryOversubscriptionEnabled: false }, Namespace: "private", Region: "foreign" };
    expect((await app.request("/node-pools", "PUT", pool)).status).toBe(200);
    const [url, init] = app.upstream.mock.calls[0]!;
    expect(new URL(url).pathname).toBe("/v1/node/pools");
    expect(JSON.parse(init!.body!)).toEqual({ Name: "team", Description: "Team clients", Meta: { owner: "platform" }, SchedulerConfiguration: { SchedulerAlgorithm: "spread", MemoryOversubscriptionEnabled: false } });
  });
  it("streams server monitors only for a member of the configured cluster with fixed target and ACL headers", async () => {
    const app = await setup({ upstream: async url => new URL(url).pathname === "/v1/agent/members" ? Response.json({ Members: [{ Name: "server-1" }] }) : new Response("server log line\n", { headers: { "Content-Type": "text/plain" } }) });
    expect((await app.request("/servers/foreign/monitor")).status).toBe(404);
    const response = await app.request("/servers/server-1/monitor?level=warn&server_id=foreign&token=caller-secret");
    expect(await response.text()).toBe("server log line\n");
    const [target, init] = app.upstream.mock.calls[2]!;
    const url = new URL(target);
    expect(url.hostname).toBe("nomad.internal"); expect(url.pathname).toBe("/v1/agent/monitor");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ server_id: "server-1", log_level: "warn", plain: "true" });
    expect(url.searchParams.has("token")).toBe(false);
    expect(init?.headers).toMatchObject({ "X-Nomad-Token": "cluster-private-token" });
    expect(init?.redirect).toBe("error");
  });
  it("preserves denied diagnostic errors instead of claiming an empty cluster", async () => {
    const app = await setup({ upstream: async () => new Response("cluster-private-token", { status: 403 }) });
    const response = await app.request("/servers/raft"); expect(response.status).toBe(403); expect(await response.text()).not.toContain("cluster-private-token");
  });
});

describe("Node pool lifecycle safeguards", () => {
  it("permits default pool configuration but prevents all-pool writes and built-in deletion", async () => {
    const app = await setup({ upstream: async () => new Response(null, { status: 204 }) });
    expect((await app.request("/node-pools/default", "PUT", { Name: "default", Description: "Shared clients" })).status).toBe(200);
    expect((await app.request("/node-pools/all", "PUT", { Name: "all" })).status).toBe(400);
    expect((await app.request("/node-pools/default", "DELETE")).status).toBe(400);
    expect((await app.request("/node-pools/all", "DELETE")).status).toBe(400);
    expect(app.upstream).toHaveBeenCalledTimes(1);
  });
  it("deletes a custom pool using the singular escaped official endpoint", async () => {
    const app = await setup({ upstream: async () => new Response(null, { status: 204 }) });
    expect((await app.request("/node-pools/team", "DELETE")).status).toBe(200);
    expect(new URL(app.upstream.mock.calls[0]![0]).pathname).toBe("/v1/node/pool/team");
    expect(app.upstream.mock.calls[0]![1]?.method).toBe("DELETE");
  });
});
