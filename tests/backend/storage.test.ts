import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { PluginContext, PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import { registerStorageRoutes } from "../../src/backend/storage-routes.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed;
  }));
});
const storedVolume = { ID: "disk", Name: "Database", Namespace: "default", PluginID: "provider", ExternalID: "external/disk", Capacity: 100 };
const storedVariable = { Path: "apps/web", Namespace: "default", Items: { token: "private-variable" }, ModifyIndex: 7 };
const registration = { ID: "instance", ServiceName: "web", Namespace: "default", AllocID: "alloc", Address: "10.1.0.2", Port: 8080 };
async function setup(options: { manage?: boolean; use?: boolean; actor?: boolean; connect?: boolean; upstream?: PluginFetch } = {}) {
  const upstream = vi.fn<PluginFetch>(options.upstream ?? (async url => {
    const path = new URL(url).pathname;
    if (path === "/v1/service/web") return Response.json([registration]);
    if (path === "/v1/allocation/alloc") return Response.json({ ID: "alloc", Namespace: "default" });
    if (path.startsWith("/v1/volume/")) return Response.json(storedVolume);
    if (path.startsWith("/v1/var/")) return Response.json(storedVariable);
    return new Response(null, { status: 204 });
  }));
  const values: Record<string, unknown> = { enableNomad: true, address: "https://nomad.internal:4646", region: "global", token: "storage-private-token" };
  const settings = vi.fn(async (_host: number, key: string) => values[key]);
  const host = vi.fn(async () => ({ id: 7, ip: "10.0.0.7" }));
  const ctx = {
    fetch: upstream, currentActor: () => options.actor === false ? null : "actor",
    hosts: { get: host, checkAccess: async () => ({ hasAccess: options.connect !== false }) }, settings: { getHost: settings },
    rbac: { has: async (permission: string) => permission === "manage" ? options.manage !== false : permission === "use" ? options.use !== false : true },
  } as unknown as PluginContext;
  const app = express(); app.use(express.json()); registerStorageRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1"); servers.push(server); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hosts/7`;
  const request = (path: string, method = "GET", body?: unknown) => fetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { upstream, settings, host, request };
}

describe("Storage and discovery trust boundaries", () => {
  it("denies every mutation before host or credential lookup", async () => {
    const app = await setup({ manage: false });
    for (const [method, path] of [["DELETE", "/services/web/instance"], ["POST", "/csi-volumes/create"], ["POST", "/csi-volumes/register"], ["DELETE", "/csi-volumes/disk"], ["POST", "/csi-volumes/disk/delete"], ["POST", "/csi-volumes/disk/expand"], ["POST", "/csi-volumes/disk/snapshots"], ["POST", "/csi-volumes/disk/snapshots/delete"], ["POST", "/host-volumes/create"], ["POST", "/host-volumes/register"], ["DELETE", "/host-volumes/disk"], ["PUT", "/variable"], ["DELETE", "/variable?path=apps/web&cas=7"]]) {
      expect((await app.request(path!, method!, {})).status).toBe(403);
    }
    expect(app.host).not.toHaveBeenCalled(); expect(app.settings).not.toHaveBeenCalled(); expect(app.upstream).not.toHaveBeenCalled();
  });
  it("requires actor, use permission and host connect access for reads", async () => {
    const anonymous = await setup({ actor: false }); expect((await anonymous.request("/services")).status).toBe(401); expect(anonymous.host).not.toHaveBeenCalled();
    const noUse = await setup({ use: false }); expect((await noUse.request("/variables")).status).toBe(403); expect(noUse.host).not.toHaveBeenCalled();
    const denied = await setup({ connect: false }); expect((await denied.request("/csi-volumes")).status).toBe(403); expect(denied.settings).not.toHaveBeenCalled();
  });
  it("rejects wildcard namespace writes and cross-namespace registrations before deleting", async () => {
    const app = await setup({ upstream: async () => Response.json([{ ...registration, Namespace: "private" }]) });
    expect((await app.request("/services/web/instance?namespace=*", "DELETE")).status).toBe(400);
    expect((await app.request("/services/web/instance", "DELETE")).status).toBe(409);
    expect(app.upstream).toHaveBeenCalledTimes(1);
  });
  it("rejects mismatched volume and variable identities without mutation", async () => {
    const volumes = await setup({ upstream: async () => Response.json({ ...storedVolume, ID: "other" }) });
    expect((await volumes.request("/csi-volumes/disk/delete", "POST", {})).status).toBe(409); expect(volumes.upstream).toHaveBeenCalledTimes(1);
    const variables = await setup({ upstream: async () => Response.json({ ...storedVariable, Path: "private/key" }) });
    expect((await variables.request("/variable?path=apps/web&cas=7", "DELETE")).status).toBe(409); expect(variables.upstream).toHaveBeenCalledTimes(1);
  });
  it("refuses destructive snapshots from a different provider volume", async () => {
    const app = await setup({ upstream: async url => new URL(url).pathname === "/v1/volumes/snapshot" ? Response.json({ Snapshots: [{ ID: "snap", ExternalSourceVolumeID: "another-disk" }] }) : Response.json(storedVolume) });
    expect((await app.request("/csi-volumes/disk/snapshots/delete", "POST", { ID: "snap" })).status).toBe(409);
    expect(app.upstream).toHaveBeenCalledTimes(2);
  });
});

describe("Services and volumes official protocol", () => {
  it("flattens namespace service groups and verifies registration and allocation before checks", async () => {
    const app = await setup({ upstream: async url => {
      const path = new URL(url).pathname;
      if (path === "/v1/services") return Response.json([{ Namespace: "default", Services: [{ ServiceName: "web", Tags: ["public"] }] }]);
      if (path === "/v1/service/web") return Response.json([registration]);
      if (path === "/v1/allocation/alloc") return Response.json({ ID: "alloc", Namespace: "default" });
      return Response.json({ health: { Service: "web", Status: "success" } });
    } });
    expect(await (await app.request("/services")).json()).toEqual([{ Namespace: "default", ServiceName: "web", Tags: ["public"] }]);
    expect((await app.request("/services/web/instance/checks")).status).toBe(200);
    expect(new URL(app.upstream.mock.calls[3]![0]).pathname).toBe("/v1/client/allocation/alloc/checks");
    expect((await app.request("/services/web/missing", "DELETE")).status).toBe(404);
    expect((await app.request("/services/web/instance", "DELETE")).status).toBe(200);
    expect(app.upstream.mock.calls.at(-1)![1]!.method).toBe("DELETE");
  });
  it("keeps CSI and host pagination distinct and pins host region and credentials", async () => {
    const app = await setup({ upstream: async () => Response.json([storedVolume], { headers: { "X-Nomad-NextToken": "page-2" } }) });
    expect(await (await app.request("/csi-volumes?per_page=12&next_token=page-1&type=host&region=foreign&token=evil")).json()).toEqual({ items: [storedVolume], nextToken: "page-2" });
    const [url, init] = app.upstream.mock.calls[0]!;
    expect(Object.fromEntries(new URL(url).searchParams)).toMatchObject({ type: "csi", per_page: "12", next_token: "page-1", namespace: "default", region: "global" });
    expect(new URL(url).searchParams.has("token")).toBe(false); expect(init!.headers).toMatchObject({ "X-Nomad-Token": "storage-private-token" });
    expect(init!.redirect).toBe("error");
    await app.request("/host-volumes"); expect(new URL(app.upstream.mock.calls[1]![0]).searchParams.get("type")).toBe("host");
  });
  it("creates and registers CSI and dynamic host volumes using SDK envelopes", async () => {
    const app = await setup();
    for (const operation of ["create", "register"]) {
      const spec = { ID: "disk", Name: "Database", PluginID: "provider", ExternalID: "provider-id" };
      expect((await app.request(`/csi-volumes/${operation}`, "POST", { Volume: spec })).status).toBe(200);
      const [url, init] = app.upstream.mock.calls.at(-1)!;
      expect(new URL(url).pathname).toBe(`/v1/volume/csi/disk${operation === "create" ? "/create" : ""}`);
      expect(init!.method).toBe("PUT"); expect(JSON.parse(init!.body!)).toEqual({ Volumes: [{ ...spec, Namespace: "default" }] });
      const host = { Name: "Local data", NodeID: "node", HostPath: "/mnt/data", RequestedCapacityMinBytes: 1024 };
      expect((await app.request(`/host-volumes/${operation}`, "POST", { Volume: host })).status).toBe(200);
      const [hostURL, hostInit] = app.upstream.mock.calls.at(-1)!;
      expect(new URL(hostURL).pathname).toBe(`/v1/volume/host/${operation}`); expect(JSON.parse(hostInit!.body!)).toEqual({ Volume: { ...host, Namespace: "default" } });
    }
    expect((await app.request("/csi-volumes/create", "POST", { Volume: { ...storedVolume, Namespace: "other" } })).status).toBe(400);
    expect((await app.request("/host-volumes/register", "POST", { Volume: { Name: "Missing node" } })).status).toBe(400);
  });
  it("separates Nomad deregistration, provider deletion and expansion", async () => {
    const app = await setup();
    expect((await app.request("/csi-volumes/disk?force=true", "DELETE")).status).toBe(200);
    expect(new URL(app.upstream.mock.calls.at(-1)![0]).pathname).toBe("/v1/volume/csi/disk");
    expect(new URL(app.upstream.mock.calls.at(-1)![0]).searchParams.get("force")).toBe("true");
    expect((await app.request("/csi-volumes/disk/delete", "POST", { Secrets: { api: "secret-value" } })).status).toBe(200);
    const [url, init] = app.upstream.mock.calls.at(-1)!;
    expect(new URL(url).pathname).toBe("/v1/volume/csi/external%2Fdisk/delete"); expect(init!.headers).toMatchObject({ "X-Nomad-CSI-Secrets": "api=secret-value" }); expect(new URL(url).search).not.toContain("secret-value");
    expect((await app.request("/csi-volumes/disk/expand", "POST", { RequestedCapacityMin: 200, RequestedCapacityMax: 300 })).status).toBe(200);
    expect(JSON.parse(app.upstream.mock.calls.at(-1)![1]!.body!)).toMatchObject({ Volumes: [{ ID: "disk", RequestedCapacityMin: 200, RequestedCapacityMax: 300 }] });
    expect((await app.request("/csi-volumes/disk/expand", "POST", { RequestedCapacityMin: 99, RequestedCapacityMax: 0 })).status).toBe(400);
    expect((await app.request("/host-volumes/disk", "DELETE")).status).toBe(200); expect(new URL(app.upstream.mock.calls.at(-1)![0]).pathname).toBe("/v1/volume/host/disk");
  });
  it("lists private snapshots without URL secrets, filters by source and deletes only the selected page", async () => {
    const app = await setup({ upstream: async url => new URL(url).pathname === "/v1/volumes/snapshot" ? Response.json({ Snapshots: [{ ID: "snap", ExternalSourceVolumeID: storedVolume.ExternalID }, { ID: "other", ExternalSourceVolumeID: "other" }], NextToken: "cursor-2" }) : Response.json(storedVolume) });
    const result = await app.request("/csi-volumes/disk/snapshots/list", "POST", { nextToken: "cursor-1", Secrets: { api: "snapshot-secret" } });
    expect(await result.json()).toEqual({ items: [{ ID: "snap", ExternalSourceVolumeID: storedVolume.ExternalID }], nextToken: "cursor-2" });
    const [url, init] = app.upstream.mock.calls[1]!;
    expect(Object.fromEntries(new URL(url).searchParams)).toMatchObject({ plugin_id: "provider", next_token: "cursor-1", per_page: "50" }); expect(init!.headers).toMatchObject({ "X-Nomad-CSI-Secrets": "api=snapshot-secret" }); expect(url).not.toContain("snapshot-secret");
    expect((await app.request("/csi-volumes/disk/snapshots", "POST", { Name: "Backup", Secrets: { api: "snapshot-secret" }, Parameters: { tier: "cold" } })).status).toBe(200);
    expect(JSON.parse(app.upstream.mock.calls.at(-1)![1]!.body!)).toEqual({ Snapshots: [{ Name: "Backup", SourceVolumeID: "disk", PluginID: "provider", Secrets: { api: "snapshot-secret" }, Parameters: { tier: "cold" } }] });
    expect((await app.request("/csi-volumes/disk/snapshots/delete", "POST", { ID: "snap", nextToken: "cursor-1", Secrets: { api: "snapshot-secret" } })).status).toBe(200);
    expect(app.upstream.mock.calls.at(-1)![1]!.method).toBe("DELETE"); expect(new URL(app.upstream.mock.calls.at(-1)![0]).searchParams.get("snapshot_id")).toBe("snap");
  });
});

describe("Variable metadata and CAS", () => {
  it("lists metadata only and preserves hierarchical paths and template item keys", async () => {
    const app = await setup({ upstream: async (url, init) => new URL(url).pathname === "/v1/vars" ? Response.json([storedVariable], { headers: { "X-Nomad-NextToken": "next" } }) : Response.json({ ...storedVariable, ...JSON.parse(init?.body ?? "{}") }) });
    const result = await app.request("/variables?prefix=apps/&per_page=2"); const body = await result.json();
    expect(body.items[0]).toEqual({ Path: "apps/web", Namespace: "default", ModifyIndex: 7 }); expect(JSON.stringify(body)).not.toContain("private-variable");
    const Path = "nomad/job-templates/web"; const Items = { template: 'job "web" {}', description: "Web service" };
    expect((await app.request("/variable", "PUT", { Path, Items, ModifyIndex: 0 })).status).toBe(200);
    const [url, init] = app.upstream.mock.calls.at(-1)!;
    expect(new URL(url).pathname).toBe("/v1/var/nomad/job-templates/web"); expect(new URL(url).searchParams.get("cas")).toBe("0"); expect(JSON.parse(init!.body!)).toEqual({ Path, Namespace: "default", Items });
  });
  it("uses caller CAS for edit and delete and never blindly overwrites", async () => {
    const app = await setup();
    expect((await app.request("/variable", "PUT", { Path: "apps/web", Items: { key: "edited" }, ModifyIndex: 7 })).status).toBe(200);
    expect(new URL(app.upstream.mock.calls.at(-1)![0]).searchParams.get("cas")).toBe("7");
    expect((await app.request("/variable?path=apps/web&cas=7", "DELETE")).status).toBe(200); expect(new URL(app.upstream.mock.calls.at(-1)![0]).searchParams.get("cas")).toBe("7");
    const calls = app.upstream.mock.calls.length;
    for (const cas of ["0", "-1", "1.5", "9007199254740992", ""]) expect((await app.request(`/variable?path=apps/web&cas=${cas}`, "DELETE")).status).toBe(400);
    expect((await app.request("/variable", "PUT", { Path: "apps/web", Items: { key: "bad" } })).status).toBe(400);
    expect(app.upstream).toHaveBeenCalledTimes(calls);
  });
  it("rejects unsafe paths and namespace overrides and preserves sanitized upstream CAS errors", async () => {
    const app = await setup();
    for (const path of ["/absolute", "apps/../secret", "apps//web", "apps/"]) expect((await app.request(`/variable?path=${encodeURIComponent(path)}`)).status).toBe(400);
    expect((await app.request("/variable", "PUT", { Path: "apps/web", Namespace: "private", Items: {}, ModifyIndex: 0 })).status).toBe(400); expect(app.upstream).not.toHaveBeenCalled();
    const conflict = await setup({ upstream: async () => new Response("storage-private-token and private-variable", { status: 409 }) });
    const result = await conflict.request("/variable", "PUT", { Path: "apps/web", Items: { token: "private-variable" }, ModifyIndex: 0 });
    expect(result.status).toBe(409); expect(await result.text()).not.toContain("private-variable");
  });
});
