import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { PluginContext, PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import { registerAdministrationRoutes } from "../../src/backend/administration-routes.js";

const accessor = "11111111-1111-4111-8111-111111111111";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed;
  }));
});
async function setup(options: { admin?: boolean; fetch?: PluginFetch } = {}) {
  const upstream = vi.fn<PluginFetch>(options.fetch ?? (async () => Response.json(null)));
  const values: Record<string, unknown> = { enableNomad: true, address: "https://nomad.internal:4646", token: "connection-secret", region: "global" };
  const settings = vi.fn(async (_id: number, key: string) => values[key]);
  const host = vi.fn(async () => ({ id: 7, ip: "10.0.0.7" }));
  const ctx = { currentActor: () => "admin", fetch: upstream, settings: { getHost: settings }, hosts: { get: host, checkAccess: async () => ({ hasAccess: true }) }, rbac: { has: async (permission: string) => permission !== "administer" || options.admin !== false } } as unknown as PluginContext;
  const app = express(); app.use(express.json()); registerAdministrationRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1"); servers.push(server); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hosts/7/administration`;
  return { upstream, host, settings, request: (path: string, method = "GET", body?: unknown) => fetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
}

const token = { AccessorID: accessor, SecretID: "new-secret", Name: "operator", Type: "client", Global: false, Policies: ["read"], Roles: [{ ID: accessor }], ExpirationTime: "2030-01-01T00:00:00Z" };

describe("Administration trust boundaries", () => {
  it("requires admin before host or credential lookup for every resource and action", async () => {
    const app = await setup({ admin: false });
    for (const resource of ["namespaces", "policies", "roles", "tokens", "auth-methods", "binding-rules", "sentinel"]) {
      for (const [suffix, method] of [["", "GET"], ["", "POST"], [`/${accessor}`, "GET"], [`/${accessor}`, "PUT"], [`/${accessor}`, "DELETE"]]) {
        expect((await app.request(`/${resource}${suffix}`, method, method === "POST" || method === "PUT" ? {} : undefined)).status).toBe(403);
      }
    }
    for (const action of ["secret", "clone"]) expect((await app.request(`/tokens/${accessor}/${action}`, "POST", {})).status).toBe(403);
    expect(app.host).not.toHaveBeenCalled(); expect(app.settings).not.toHaveBeenCalled(); expect(app.upstream).not.toHaveBeenCalled();
  });
  it("never puts token secrets in lists, normal detail, or update responses", async () => {
    const app = await setup({ fetch: async url => Response.json(new URL(url).pathname.endsWith("/tokens") ? [token] : token) });
    const list = await app.request("/tokens");
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toEqual({ items: [{ ...token, SecretID: undefined }], nextToken: "" });
    expect(await (await app.request(`/tokens/${accessor}`)).text()).not.toContain("new-secret");
    const { SecretID: _secret, ...input } = token;
    expect(await (await app.request(`/tokens/${accessor}`, "PUT", input)).text()).not.toContain("new-secret");
    expect((await app.request("/tokens/self")).status).toBe(400);
  });
  it("only reveals secrets intentionally and refuses the configured connection credential", async () => {
    const app = await setup({ fetch: async () => Response.json(token) });
    const revealed = await app.request(`/tokens/${accessor}/secret`, "POST");
    expect(await revealed.json()).toEqual({ secret: "new-secret" });
    expect(revealed.headers.get("cache-control")).toBe("no-store");
    const configured = await setup({ fetch: async () => Response.json({ ...token, SecretID: "connection-secret", Name: "connection-secret", Meta: { "connection-secret": ["connection-secret"] } }) });
    expect((await configured.request(`/tokens/${accessor}/secret`, "POST")).status).toBe(403);
    expect(await (await configured.request(`/tokens/${accessor}`)).text()).not.toContain("connection-secret");
    const result = await configured.request("/tokens", "POST", { Name: "new", Type: "client", Global: false });
    expect(await result.text()).not.toContain("connection-secret");
    expect((await app.request("/tokens", "POST", { ...token, AccessorID: undefined })).status).toBe(400);
  });
  it("surfaces ACL/edition denials without leaking upstream body content", async () => {
    for (const status of [403, 404, 501]) {
      const app = await setup({ fetch: async () => new Response("license denied connection-secret", { status }) });
      const result = await app.request("/sentinel");
      expect(result.status).toBe(status === 501 ? 502 : status);
      const body = await result.json(); expect(body.error).toContain(String(status)); expect(JSON.stringify(body)).not.toContain("connection-secret");
    }
  });
});

describe("Administration Nomad protocol", () => {
  it("clones permissions into a generated token, without copying source identity, secret, or expiration", async () => {
    const app = await setup({ fetch: async () => Response.json(token) });
    const result = await app.request(`/tokens/${accessor}/clone`, "POST", { Name: "clone", ExpirationTTL: "1h" });
    expect(await result.json()).toMatchObject({ token: { AccessorID: accessor }, secret: "new-secret" });
    expect(app.upstream).toHaveBeenCalledTimes(2);
    const [url, request] = app.upstream.mock.calls[1]!;
    expect(new URL(url).pathname).toBe("/v1/acl/token");
    expect(JSON.parse(request!.body!)).toEqual({ Name: "clone", Type: "client", Global: false, Policies: ["read"], Roles: [{ ID: accessor }], ExpirationTTL: "1h" });
    expect(request!.method).toBe("PUT");
  });
  it.each([
    ["namespaces", { Name: "team", Description: "Team", Meta: { owner: "ops" }, NodePoolConfiguration: { Default: "workers" } }, "/v1/namespace", "/v1/namespace/team"],
    ["policies", { Name: "read", Rules: 'namespace "team" { policy = "read" }' }, "/v1/acl/policy/read", "/v1/acl/policy/read"],
    ["roles", { Name: "reader", Policies: [{ Name: "read" }] }, "/v1/acl/role", `/v1/acl/role/${accessor}`],
    ["auth-methods", { Name: "sso", Type: "OIDC", TokenLocality: "local", MaxTokenTTL: "1h", Default: false, Config: { OIDCDiscoveryURL: "https://id.example", OIDCClientID: "nomad" } }, "/v1/acl/auth-method", "/v1/acl/auth-method/sso"],
    ["binding-rules", { AuthMethod: "sso", BindType: "role", BindName: "reader", Selector: '"ops" in list.groups' }, "/v1/acl/binding-rule", `/v1/acl/binding-rule/${accessor}`],
    ["sentinel", { Name: "guard", Scope: "submit-job", EnforcementLevel: "hard-mandatory", Policy: "main = rule { true }" }, "/v1/sentinel/policy/guard", "/v1/sentinel/policy/guard"],
  ] as const)("supports %s create/update/delete on the official fixed paths", async (resource, body, createPath, itemPath) => {
    const app = await setup();
    expect((await app.request(`/${resource}`, "POST", body)).status).toBe(200);
    expect(new URL(app.upstream.mock.calls[0]![0]).pathname).toBe(createPath);
    const key = resource === "roles" || resource === "binding-rules" ? accessor : "Name" in body ? body.Name : "";
    expect((await app.request(`/${resource}/${key}`, "PUT", body)).status).toBe(200);
    expect(new URL(app.upstream.mock.calls[1]![0]).pathname).toBe(resource === "namespaces" ? createPath : itemPath);
    expect((await app.request(`/${resource}/${key}`, "DELETE")).status).toBe(200);
    expect(new URL(app.upstream.mock.calls[2]![0]).pathname).toBe(itemPath);
    expect(app.upstream.mock.calls[2]![1]!.method).toBe("DELETE");
  });
  it.each([
    ["namespaces", "/v1/namespaces", "/v1/namespace/team", { Name: "team" }, "team"],
    ["policies", "/v1/acl/policies", "/v1/acl/policy/read", { Name: "read", Rules: "node { policy = \"read\" }" }, "read"],
    ["roles", "/v1/acl/roles", `/v1/acl/role/${accessor}`, { ID: accessor, Name: "reader", Policies: [{ Name: "read" }] }, accessor],
    ["auth-methods", "/v1/acl/auth-methods", "/v1/acl/auth-method/sso", { Name: "sso", Type: "OIDC" }, "sso"],
    ["binding-rules", "/v1/acl/binding-rules", `/v1/acl/binding-rule/${accessor}`, { ID: accessor, AuthMethod: "sso" }, accessor],
    ["sentinel", "/v1/sentinel/policies", "/v1/sentinel/policy/guard", { Name: "guard", Policy: "main = rule { true }" }, "guard"],
  ] as const)("reads %s with honest pagination and full detail", async (resource, listPath, itemPath, item, key) => {
    const app = await setup({ fetch: async url => new URL(url).pathname === listPath ? Response.json([item], { headers: { "X-Nomad-NextToken": "next-page" } }) : Response.json(item) });
    const result = await app.request(`/${resource}?prefix=t&per_page=10&next_token=cursor`);
    expect(await result.json()).toEqual({ items: [item], nextToken: "next-page" });
    const url = new URL(app.upstream.mock.calls[0]![0]);
    expect(url.pathname).toBe(listPath); expect(url.searchParams.get("prefix")).toBe("t"); expect(url.searchParams.get("next_token")).toBe("cursor");
    expect(await (await app.request(`/${resource}/${key}`)).json()).toEqual(item);
    expect(new URL(app.upstream.mock.calls[1]![0]).pathname).toBe(itemPath);
  });
  it("rejects identity changes and malformed payloads before requesting upstream", async () => {
    const app = await setup();
    expect((await app.request("/namespaces/team", "PUT", { Name: "other" })).status).toBe(400);
    expect((await app.request("/roles", "POST", { Name: "empty", Policies: [] })).status).toBe(400);
    expect((await app.request("/auth-methods", "POST", { Name: "sso", Type: "http" })).status).toBe(400);
    expect((await app.request("/sentinel", "POST", { Name: "guard", Scope: "invalid" })).status).toBe(400);
    expect(app.upstream).not.toHaveBeenCalled();
  });
});
