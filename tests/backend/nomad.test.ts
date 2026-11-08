import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { once } from "node:events";
import type { PluginContext, PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import { hostClient, jobInput, LOG_BYTES, namespace, NomadClient, nonnegativeInteger } from "../../src/backend/client.js";
import { registerRoutes } from "../../src/backend/routes.js";
import { registerJobOperationsRoutes } from "../../src/backend/job-operations.js";
import { registerAllocationRoutes } from "../../src/backend/allocation-routes.js";
import { registerClusterRoutes } from "../../src/backend/cluster-routes.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }));
});

async function setup(options: { manage?: boolean; connect?: boolean; use?: boolean; visible?: boolean; enabled?: boolean; fetch?: PluginFetch } = {}) {
  const upstream = vi.fn<PluginFetch>(options.fetch ?? (async () => Response.json({})));
  const values: Record<string, unknown> = { enableNomad: options.enabled !== false, address: "https://nomad.internal:4646", region: "global", token: "secret-acl-token" };
  const settings = vi.fn(async (_id: number, key: string) => values[key]);
  const host = vi.fn(async () => options.visible === false ? null : { id: 7, ip: "10.0.0.7" });
  const ctx = {
    fetch: upstream, currentActor: () => "user-1", hosts: { get: host, checkAccess: async () => ({ hasAccess: options.connect !== false }) }, settings: { getHost: settings },
    rbac: { has: async (permission: string) => !((permission === "manage" && options.manage === false) || (permission === "use" && options.use === false)) },
  } as unknown as PluginContext;
  const app = express();
  app.use(express.json({ limit: "3mb" }));
  registerRoutes(app, ctx);
  registerJobOperationsRoutes(app, ctx);
  registerAllocationRoutes(app, ctx);
  registerClusterRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { ctx, upstream, settings, host, request: (path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${port}/hosts/7${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
}

describe("Nomad trust boundaries", () => {
  it("checks host visibility before reading credentials", async () => {
    const server = await setup({ visible: false });
    const viewOnly = await setup({ connect: false });
    expect((await viewOnly.request("/jobs")).status).toBe(403);
    expect(viewOnly.settings).not.toHaveBeenCalled();
    expect(viewOnly.upstream).not.toHaveBeenCalled();
    const noUse = await setup({ use: false });
    expect((await noUse.request("/jobs")).status).toBe(403);
    expect(noUse.host).not.toHaveBeenCalled();
    expect((await server.request("/jobs")).status).toBe(404);
    expect(server.settings).not.toHaveBeenCalled();
    expect(server.upstream).not.toHaveBeenCalled();
  });
  it("requires enableNomad and manage permission for writes", async () => {
    const disabled = await setup({ enabled: false });
    expect((await disabled.request("/jobs")).status).toBe(403);
    expect(disabled.upstream).not.toHaveBeenCalled();
    const readOnly = await setup({ manage: false, fetch: async () => Response.json({ JobModifyIndex: 0 }) });
    expect((await readOnly.request("/plan", "POST", { job: { ID: "job" } })).status).toBe(200);
    expect((await readOnly.request("/jobs", "PUT", { job: { ID: "job" }, modifyIndex: 0 })).status).toBe(403);
    expect((await readOnly.request("/jobs/job", "DELETE")).status).toBe(403);
    expect((await readOnly.request("/jobs/job/scale", "POST", { group: "web", count: 2 })).status).toBe(403);
  });
  it("never exposes upstream error bodies or fetch errors containing tokens", async () => {
    const denied = await setup({ fetch: async () => new Response("<html>secret-acl-token</html>", { status: 403 }) });
    const response = await denied.request("/jobs");
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("secret-acl-token");
    const failed = await setup({ fetch: async () => { throw new Error("secret-acl-token"); } });
    expect(await (await failed.request("/jobs")).text()).not.toContain("secret-acl-token");
  });
  it("rejects mismatched allocation namespaces before requesting logs", async () => {
    const server = await setup({ fetch: async () => Response.json({ ID: "alloc", Namespace: "private", TaskStates: { task: {} } }) });
    expect((await server.request("/allocations/alloc/logs?namespace=default&task=task&type=stdout")).status).toBe(409);
    expect(server.upstream).toHaveBeenCalledTimes(1);
  });
  it("constrains namespaces, identities, region and integer input", () => {
    expect(namespace(undefined)).toBe("default");
    expect(() => namespace("*", true)).toThrow("concrete namespace");
    expect(() => jobInput({ ID: "job", Namespace: "other" }, "default", "global")).toThrow("namespace");
    expect(() => jobInput({ ID: "job", Region: "other" }, "default", "global")).toThrow("region");
    expect(jobInput({ ID: "job", Multiregion: { Regions: [{ Name: "global" }] } }, "default", "global")).toMatchObject({ Multiregion: { Regions: [{ Name: "global" }] } });
    for (const value of [-1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1, NaN]) expect(() => nonnegativeInteger(value, "Count")).toThrow();
    expect(nonnegativeInteger(0, "Count")).toBe(0);
  });
});

describe("Nomad HTTP protocol", () => {
  it("encodes job IDs and pins outbound host with ACL headers and no redirects", async () => {
    const id = "parent/periodic-123 ?#%";
    const server = await setup({ fetch: async () => Response.json({ ID: id, Namespace: "team" }) });
    expect((await server.request(`/jobs/${encodeURIComponent(id)}?namespace=team`)).status).toBe(200);
    const [target, init] = server.upstream.mock.calls[0]!;
    const url = new URL(target);
    expect(url.pathname).toBe(`/v1/job/${encodeURIComponent(id)}`);
    expect(url.searchParams.get("namespace")).toBe("team");
    expect(init).toMatchObject({ redirect: "error", allowPrivateHosts: ["nomad.internal"], headers: { "X-Nomad-Token": "secret-acl-token" } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.tls?.rejectUnauthorized).not.toBe(false);
  });
  it("registers using CAS and refuses unsafe indices and wildcard writes", async () => {
    const server = await setup({ fetch: async () => Response.json({ EvalID: "eval" }) });
    expect((await server.request("/jobs", "PUT", { job: { ID: "job" }, modifyIndex: 42 })).status).toBe(200);
    const input = JSON.parse(server.upstream.mock.calls[0]![1]!.body!);
    expect(input).toEqual({ Job: { ID: "job", Namespace: "default", Region: "global" }, EnforceIndex: true, JobModifyIndex: 42 });
    expect((await server.request("/jobs", "PUT", { job: { ID: "job" }, modifyIndex: Number.MAX_SAFE_INTEGER + 1 })).status).toBe(400);
    expect((await server.request("/jobs?namespace=*", "PUT", { job: { ID: "job" }, modifyIndex: 0 })).status).toBe(400);
    expect(server.upstream).toHaveBeenCalledTimes(1);
  });
  it("unwraps JSON jobs without requiring Nomad's HCL parser", async () => {
    const server = await setup({ fetch: async () => Response.json({ ID: "job", Namespace: "default" }) });
    const json = await server.request("/parse", "POST", { format: "json", source: '{"Job":{"ID":"job"}}' });
    expect(await json.json()).toMatchObject({ ID: "job", Namespace: "default" });
    expect(server.upstream).not.toHaveBeenCalled();
  });
  it("rejects unsafe plan indices instead of silently rounding", async () => {
    const server = await setup({ fetch: async () => new Response('{"JobModifyIndex":9007199254740993}') });
    expect((await server.request("/plan", "POST", { job: { ID: "job" } })).status).toBe(502);
  });
  it("normalizes null lists", async () => {
    const server = await setup({ fetch: async () => Response.json(null) });
    expect(await (await server.request("/jobs")).json()).toEqual([]);
    expect(await (await server.request("/node-list")).json()).toEqual([]);
  });
  it("requests finite server-proxied logs and bounds returned bytes", async () => {
    const server = await setup({ fetch: async url => new URL(url).pathname.includes("/allocation/")
      ? Response.json({ ID: "alloc", Namespace: "default", TaskStates: { task: {} } })
      : new Response("x".repeat(LOG_BYTES + 100)) });
    const response = await server.request("/allocations/alloc/logs?task=task&type=stdout");
    expect(await response.json()).toEqual({ text: "x".repeat(LOG_BYTES) });
    const url = new URL(server.upstream.mock.calls[1]![0]);
    expect(url.pathname).toBe("/v1/client/fs/logs/alloc");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ task: "task", type: "stdout", origin: "end", offset: "65536", follow: "false", plain: "true" });
  });
  it("rejects oversized JSON and invalid host identifiers", async () => {
    const client = new NomadClient({ fetch: async () => new Response(" ".repeat(4 * 1024 * 1024 + 1)) }, new URL("http://nomad:4646"), "", "global");
    await expect(client.request("/v1/jobs", "default")).rejects.toThrow("size limit");
    const server = await setup();
    await expect(hostClient(server.ctx, "7x")).rejects.toThrow("host ID");
    expect(server.host).not.toHaveBeenCalled();
  });
});

describe("Native jobs and scheduler operations", () => {
  it("provides cursor paging without changing the array jobs API", async () => {
    const server = await setup({ fetch: async () => Response.json([{ ID: "web", Namespace: "team" }], { headers: { "X-Nomad-NextToken": "cursor/+=" } }) });
    const response = await server.request("/job-list?namespace=team&per_page=25&next_token=prior%2F%2B&prefix=web&filter=Status%20%3D%3D%20running&reverse=true");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: [{ ID: "web", Namespace: "team" }], nextToken: "cursor/+=" });
    expect(Object.fromEntries(new URL(server.upstream.mock.calls[0]![0]).searchParams)).toMatchObject({ namespace: "team", region: "global", per_page: "25", next_token: "prior/+", prefix: "web", filter: "Status == running", reverse: "true" });
    expect(await (await server.request("/jobs?namespace=team")).json()).toEqual([{ ID: "web", Namespace: "team" }]);
    for (const query of ["per_page=0", "per_page=201", "reverse=maybe", "filter=a&filter=b"]) expect((await server.request(`/job-list?${query}`)).status).toBe(400);
  });

  it("loads real version differences and guards revert with the current version", async () => {
    const server = await setup({ fetch: async url => new URL(url).pathname.endsWith("/versions")
      ? Response.json({ Versions: [{ ID: "web", Namespace: "team", Version: 2 }], Diffs: [{ Type: "Edited" }] })
      : Response.json({ ID: "web", Namespace: "team", Version: 3 }) });
    const response = await server.request("/jobs/web/versions?namespace=team&diff_version=2");
    expect(await response.json()).toMatchObject({ Versions: [{ Version: 2 }], Diffs: [{ Type: "Edited" }] });
    expect(new URL(server.upstream.mock.calls[1]![0]).searchParams.get("diff_version")).toBe("2");
    expect(new URL(server.upstream.mock.calls[1]![0]).searchParams.get("diffs")).toBe("true");
    expect((await server.request("/jobs/web/revert?namespace=team", "POST", { version: 2, enforcePriorVersion: 3 })).status).toBe(200);
    const [target, init] = server.upstream.mock.calls.at(-1)!;
    expect(new URL(target).pathname).toBe("/v1/job/web/revert");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init!.body!)).toEqual({ JobID: "web", JobVersion: 2, EnforcePriorVersion: 3 });
    const writes = server.upstream.mock.calls.filter(([, options]) => options?.method === "PUT").length;
    expect((await server.request("/jobs/web/revert?namespace=team", "POST", { version: 1, enforcePriorVersion: 2 })).status).toBe(409);
    expect((await server.request("/jobs/web/revert?namespace=team", "POST", { version: Number.MAX_SAFE_INTEGER + 1, enforcePriorVersion: 3 })).status).toBe(400);
    expect(server.upstream.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(writes);
    expect((await server.request("/jobs/web/versions?namespace=team&diff_version=-1")).status).toBe(400);
  });

  it("uses upstream lifecycle methods and UTF-8 dispatch payload encoding", async () => {
    const server = await setup({ fetch: async () => Response.json({ ID: "parent/child", Namespace: "team", Periodic: { Enabled: true }, ParameterizedJob: {} }) });
    const jobPath = `/jobs/${encodeURIComponent("parent/child")}`;
    const cases = [
      ["evaluate", { forceReschedule: true }, "/evaluate", { JobID: "parent/child", EvalOptions: { ForceReschedule: true } }],
      ["dispatch", { meta: { team: "ops" }, payload: "payload", idPrefix: "manual" }, "/dispatch", { JobID: "parent/child", Meta: { team: "ops" }, Payload: Buffer.from("payload").toString("base64"), IdPrefixTemplate: "manual" }],
    ] as const;
    for (const [action, body, suffix, expected] of cases) {
      expect((await server.request(`${jobPath}/${action}?namespace=team`, "POST", body)).status).toBe(200);
      const [target, init] = server.upstream.mock.calls.at(-1)!;
      expect(new URL(target).pathname).toBe(`/v1/job/parent%2Fchild${suffix}`);
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init!.body!)).toEqual(expected);
    }
    expect((await server.request(`${jobPath}/periodic-force?namespace=team`, "POST", {})).status).toBe(200);
    expect(new URL(server.upstream.mock.calls.at(-1)![0]).pathname).toBe("/v1/job/parent%2Fchild/periodic/force");
    expect((await server.request(`${jobPath}/purge?namespace=team`, "POST", {})).status).toBe(200);
    expect(server.upstream.mock.calls.at(-1)![1]?.method).toBe("DELETE");
    expect(new URL(server.upstream.mock.calls.at(-1)![0]).searchParams.get("purge")).toBe("true");
    expect((await server.request(`${jobPath}/evaluate?namespace=team`, "POST", { forceReschedule: "true" })).status).toBe(400);
    expect((await server.request(`${jobPath}/dispatch?namespace=team`, "POST", { meta: { key: 7 }, payload: "" })).status).toBe(400);
    expect((await server.request(`${jobPath}/dispatch?namespace=team`, "POST", { meta: {}, payload: "x".repeat(16385) })).status).toBe(400);
    const ordinary = await setup({ fetch: async () => Response.json({ ID: "web", Namespace: "default" }) });
    expect((await ordinary.request("/jobs/web/periodic-force", "POST", {})).status).toBe(400);
    expect((await ordinary.request("/jobs/web/dispatch", "POST", { meta: {}, payload: "" })).status).toBe(400);
  });

  it("performs every deployment rollout action against its native endpoint", async () => {
    const server = await setup({ fetch: async () => Response.json({ ID: "rollout", Namespace: "team", TaskGroups: { web: {} } }) });
    for (const action of ["promote", "fail", "pause", "resume", "unblock"]) {
      expect((await server.request(`/deployments/rollout/${action}?namespace=team`, "POST", action === "promote" ? { groups: ["web"] } : {})).status).toBe(200);
      const [target, init] = server.upstream.mock.calls.at(-1)!;
      expect(new URL(target).pathname).toBe(`/v1/deployment/${action === "resume" ? "pause" : action}/rollout`);
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init!.body!)).toEqual({ DeploymentID: "rollout", ...(action === "promote" ? { Groups: ["web"] } : {}), ...(["pause", "resume"].includes(action) ? { Pause: action === "pause" } : {}) });
    }
    expect((await server.request("/deployments/rollout/promote?namespace=team", "POST", { groups: [] })).status).toBe(200);
    expect(JSON.parse(server.upstream.mock.calls.at(-1)![1]!.body!)).toEqual({ DeploymentID: "rollout", All: true });
    expect((await server.request("/deployments/rollout/promote?namespace=team", "POST", { groups: ["foreign"] })).status).toBe(400);
  });

  it("loads evaluation context and verifies allocation and job references", async () => {
    const server = await setup({ fetch: async url => {
      const path = new URL(url).pathname;
      if (path.endsWith("/allocations")) return Response.json([{ ID: "alloc", Namespace: "team", EvalID: "eval" }]);
      if (path.endsWith("/services")) return Response.json([{ ID: "service", Namespace: "team", JobID: "other" }]);
      if (path.startsWith("/v1/job/")) return Response.json({ ID: "web", Namespace: "team" });
      return Response.json({ ID: "eval", Namespace: "team", JobID: "web", RelatedEvals: [] });
    } });
    expect((await server.request("/evaluations/eval?namespace=team")).status).toBe(200);
    expect(new URL(server.upstream.mock.calls[0]![0]).searchParams.get("related")).toBe("true");
    expect(await (await server.request("/evaluations/eval/allocations?namespace=team")).json()).toMatchObject([{ ID: "alloc" }]);
    expect((await server.request("/evaluations/other/allocations?namespace=team")).status).toBe(409);
    expect((await server.request("/jobs/web/services?namespace=team")).status).toBe(409);
    const foreign = await setup({ fetch: async () => Response.json({ ID: "eval", Namespace: "private" }) });
    expect((await foreign.request("/evaluations/eval?namespace=team")).status).toBe(409);
    expect((await foreign.request("/evaluations/eval/allocations?namespace=team")).status).toBe(409);
    expect(foreign.upstream).toHaveBeenCalledTimes(2);
  });

  it("denies scheduler writes before credentials and requires concrete namespaces", async () => {
    const readOnly = await setup({ manage: false });
    const writes = ["/jobs/web/revert", "/jobs/web/dispatch", "/jobs/web/evaluate", "/jobs/web/periodic-force", "/jobs/web/purge", ...["promote", "fail", "pause", "resume", "unblock"].map(action => `/deployments/rollout/${action}`)];
    for (const path of writes) expect((await readOnly.request(path, "POST", {})).status).toBe(403);
    expect(readOnly.settings).not.toHaveBeenCalled();
    expect(readOnly.upstream).not.toHaveBeenCalled();
    const wildcard = await setup();
    for (const path of writes) expect((await wildcard.request(`${path}?namespace=*`, "POST", {})).status).toBe(400);
    expect((await wildcard.request("/jobs/web/versions?namespace=*")).status).toBe(400);
    expect(wildcard.upstream).not.toHaveBeenCalled();
    const noUse = await setup({ use: false });
    expect((await noUse.request("/deployments")).status).toBe(403);
    expect((await noUse.request("/evaluations")).status).toBe(403);
    expect(noUse.settings).not.toHaveBeenCalled();
  });
});

describe("Native job creation", () => {
  const fullJob = { ID: "web", Namespace: "team", Region: "global", Multiregion: { Strategy: { MaxParallel: 1 }, Regions: [{ Name: "global", Count: 1 }] }, TaskGroups: [{ Name: "web", Tasks: [{ Name: "server", Driver: "docker", Config: { image: "nginx", arbitrary_driver_option: { enabled: true } }, Templates: [{ EmbeddedTmpl: "private source" }] }] }], Meta: { owner: "team" }, Periodic: { Spec: "* * * * *" }, ParameterizedJob: { Payload: "optional" }, UnknownFutureField: { preserve: true } };


  it("rejects malformed source, variables and scope before contacting Nomad", async () => {
    const app = await setup();
    for (const input of [
      { source: "", format: "hcl" }, { source: 7, format: "hcl" }, { source: "job", format: "yaml" },
      { source: "job", format: "hcl", variables: null }, { source: "job", format: "hcl", variables: {} },
      { source: '{"ID":"web"}', format: "json", variables: "image = 1" },
      { source: "{broken", format: "json" }, { source: "[]", format: "json" },
      { source: '{"ID":"web","Namespace":"private"}', format: "json" },
      { source: '{"ID":"web","Region":"foreign"}', format: "json" },
      { source: '{"ID":".."}', format: "json" },
    ]) expect((await app.request("/parse", "POST", input)).status).toBe(400);
    for (const endpoint of ["parse", "validate", "plan"]) expect((await app.request(`/${endpoint}?namespace=*`, "POST", {})).status).toBe(400);
    for (const job of [{ ID: "web", Namespace: "private" }, { ID: "web", Region: "foreign" }]) {
      expect((await app.request("/validate", "POST", { job })).status).toBe(400);
      expect((await app.request("/plan", "POST", { job })).status).toBe(400);
      expect((await app.request("/jobs", "PUT", { job, modifyIndex: 0 })).status).toBe(400);
    }
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it("reports native JSON line and column without echoing source text", async () => {
    const app = await setup();
    const response = await app.request("/parse", "POST", { source: '{"Job":\n{"ID":"secret-acl-token",}}', format: "json" });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toMatch(/Invalid job JSON \(line 2, column \d+\)/);
    expect(text).not.toContain("secret-acl-token");
    expect(app.upstream).not.toHaveBeenCalled();
  });

  it("bounds source and variables independently by UTF-8 bytes", async () => {
    const app = await setup({ fetch: async () => Response.json({ ID: "web" }) });
    const atLimit = "\u00e9".repeat(512 * 1024);
    expect((await app.request("/parse", "POST", { source: atLimit, format: "hcl", variables: atLimit })).status).toBe(200);
    expect((await app.request("/parse", "POST", { source: atLimit + "\u00e9", format: "hcl" })).status).toBe(400);
    expect((await app.request("/parse", "POST", { source: "job", format: "hcl", variables: atLimit + "\u00e9" })).status).toBe(400);
    expect(app.upstream).toHaveBeenCalledTimes(1);
  });

  it("normalizes Nomad's null validation errors for consumers", async () => {
    const app = await setup({ manage: false, fetch: async () => Response.json({ DriverConfigValidated: true, ValidationErrors: null, Error: "", Warnings: "" }) });
    expect(await (await app.request("/validate", "POST", { job: { ID: "web" } })).json()).toEqual({ DriverConfigValidated: true, ValidationErrors: [], Error: "", Warnings: "" });
  });

  it("rejects malformed validation responses instead of manufacturing success", async () => {
    const valid = { DriverConfigValidated: true, ValidationErrors: [], Error: "", Warnings: "" };
    for (const validation of [null, [], {}, { ...valid, DriverConfigValidated: "true" }, { ...valid, ValidationErrors: [null] }, { ...valid, ValidationErrors: undefined }, { ...valid, Error: null }, { ...valid, Warnings: [] }]) {
      const app = await setup({ fetch: async () => Response.json(validation) });
      expect((await app.request("/validate", "POST", { job: { ID: "web" } })).status).toBe(502);
    }
  });


  it("rejects unsafe submission input without registering a job", async () => {
    const app = await setup();
    for (const submission of [null, [], {}, { Source: "job", Format: "hcl" }, { Source: "", Format: "hcl2" }, { Source: "job", Format: "hcl2", Variables: 1 }, { Source: "job", Format: "json", Variables: "x = 1" }, { Source: "x".repeat(1024 * 1024 + 1), Format: "hcl2" }, { Source: "job", Format: "hcl2", Variables: "x".repeat(1024 * 1024 + 1) }]) {
      expect((await app.request("/jobs", "PUT", { job: { ID: "web" }, modifyIndex: 0, submission })).status).toBe(400);
    }
    const submission = { Source: "job", Format: "hcl2" };
    expect((await app.request("/jobs", "PUT", { job: { ID: "web" }, modifyIndex: -1, submission })).status).toBe(400);
    expect(app.upstream).not.toHaveBeenCalled();
    const readOnly = await setup({ manage: false });
    expect((await readOnly.request("/jobs", "PUT", { job: { ID: "web" }, modifyIndex: 0, submission })).status).toBe(403);
    expect(readOnly.settings).not.toHaveBeenCalled();
  });

  it("checks submission version, job identity and namespace before reading source", async () => {
    const app = await setup({ fetch: async () => Response.json(fullJob) });
    for (const version of ["", "-1", "1.5", "9007199254740992", "1&version=2"]) expect((await app.request(`/jobs/web/submission?namespace=team&version=${version}`)).status).toBe(400);
    expect((await app.request("/jobs/web/submission?namespace=team")).status).toBe(400);
    expect(app.upstream).not.toHaveBeenCalled();
    expect((await app.request("/jobs/other/submission?namespace=team&version=0")).status).toBe(409);
    expect((await app.request("/jobs/web/submission?namespace=private&version=0")).status).toBe(409);
    expect((await app.request("/jobs/web/submission?namespace=*&version=0")).status).toBe(400);
    expect(app.upstream.mock.calls.every(([url]) => !new URL(url).pathname.endsWith("/submission"))).toBe(true);
  });

  it("returns null for missing submissions and rejects malformed stored data", async () => {
    for (const missing of [false, true]) {
      const app = await setup({ fetch: async url => new URL(url).pathname.endsWith("/submission") ? missing ? new Response("missing", { status: 404 }) : Response.json(null) : Response.json({ ID: "web", Namespace: "default" }) });
      expect(await (await app.request("/jobs/web/submission?version=0")).json()).toBeNull();
    }
    const malformed = await setup({ fetch: async url => Response.json(new URL(url).pathname.endsWith("/submission") ? { Source: "private", Format: "invalid" } : { ID: "web", Namespace: "default" }) });
    const result = await malformed.request("/jobs/web/submission?version=0");
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain("private");
  });

  it("exposes useful opted-in diagnostics but redacts the ACL token at every creation stage", async () => {
    const app = await setup({ fetch: async () => new Response("job.nomad.hcl:12,4-9: Invalid expression\nsecret-acl-token", { status: 400 }) });
    const cases = [["/parse", "POST", { source: "job", format: "hcl" }], ["/validate", "POST", { job: { ID: "web" } }], ["/plan", "POST", { job: { ID: "web" } }], ["/jobs", "PUT", { job: { ID: "web" }, modifyIndex: 0 }]] as const;
    for (const [path, method, body] of cases) {
      const response = await app.request(path, method, body);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("job.nomad.hcl:12,4-9: Invalid expression");
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("secret-acl-token");
    }
    expect(await (await app.request("/jobs")).text()).not.toContain("Invalid expression");
    const conflict = await setup({ fetch: async () => new Response("Enforcing job modify index: job changed", { status: 409 }) });
    const response = await conflict.request("/jobs", "PUT", { job: { ID: "web" }, modifyIndex: 42 });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("job changed");
  });

  it("filters proxy HTML, oversized diagnostics and raw transport errors", async () => {
    for (const response of [new Response("<html>secret-acl-token proxy page</html>", { status: 400 }), new Response("<html secret-acl-token proxy page", { status: 400 }), new Response("proxy page", { status: 400, headers: { "Content-Type": "text/html" } }), new Response("x".repeat(16 * 1024 + 1) + "secret-acl-token", { status: 400 })]) {
      const app = await setup({ fetch: async () => response });
      const text = await (await app.request("/parse", "POST", { source: "job", format: "hcl" })).text();
      expect(text).not.toContain("secret-acl-token");
      expect(text).not.toContain("proxy page");
      expect(text.length).toBeLessThan(1024);
    }
    const failed = await setup({ fetch: async () => { throw new Error("secret-acl-token fetch stack"); } });
    expect(await (await failed.request("/parse", "POST", { source: "job", format: "hcl" })).json()).toEqual({ error: "Unable to contact Nomad" });
    const validation = await setup({ fetch: async () => Response.json({ DriverConfigValidated: false, ValidationErrors: ["secret-acl-token invalid", "x".repeat(16 * 1024 + 1)], Error: "secret-acl-token invalid", Warnings: "secret-acl-token warning" }) });
    const result = await (await validation.request("/validate", "POST", { job: { ID: "web" } })).text();
    expect(result).not.toContain("secret-acl-token");
    expect(result).toContain("[redacted] invalid");
    expect(result.length).toBeLessThan(1024);
  });

  it("preserves plan placement and preemption data while redacting success warnings", async () => {
    const plan = { JobModifyIndex: 42, Diff: { Type: "Added" }, Annotations: { PreemptedAllocs: [{ ID: "allocation", JobID: "low-priority" }] }, FailedTGAllocs: { web: { NodesExhausted: 1 } }, Warnings: "secret-acl-token warning" };
    const app = await setup({ fetch: async url => Response.json(new URL(url).pathname.endsWith("/plan") ? plan : { EvalID: "eval", Warnings: "secret-acl-token warning" }) });
    expect(await (await app.request("/plan?namespace=team", "POST", { job: fullJob })).json()).toEqual({ ...plan, Warnings: "[redacted] warning" });
    expect(JSON.parse(app.upstream.mock.calls[0]![1]!.body!)).toEqual({ Job: fullJob, Diff: true });
    expect(await (await app.request("/jobs?namespace=team", "PUT", { job: fullJob, modifyIndex: 42 })).json()).toEqual({ EvalID: "eval", Warnings: "[redacted] warning" });
  });

  it("redacts tokens split across chunks and cancels bounded diagnostic streams", async () => {
    const encoder = new TextEncoder();
    const cancel = vi.fn();
    let next = 0;
    const chunks = ["line 3, column 2: secret-", "acl-token invalid"];
    const client = new NomadClient({ fetch: async () => new Response(new ReadableStream({ pull(controller) { if (next < chunks.length) controller.enqueue(encoder.encode(chunks[next++]!)); else controller.close(); }, cancel }), { status: 400, headers: { "Content-Type": "text/plain" } }) }, new URL("http://nomad:4646"), "secret-acl-token", "global");
    await expect(client.request("/v1/jobs/parse", "default", { diagnostics: true })).rejects.toThrow("line 3, column 2: [redacted] invalid");
    const oversizedCancel = vi.fn();
    const oversized = new NomadClient({ fetch: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16 * 1024 + 1)); }, cancel: oversizedCancel }), { status: 400, headers: { "Content-Type": "text/plain" } }) }, new URL("http://nomad:4646"), "secret-acl-token", "global");
    await expect(oversized.request("/v1/jobs/parse", "default", { diagnostics: true })).rejects.toThrow("Nomad request failed (HTTP 400)");
    expect(oversizedCancel).toHaveBeenCalled();
  });

  it("times out and cancels stalled diagnostic reads", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const client = new NomadClient({ fetch: async () => new Response(new ReadableStream({ cancel }), { status: 400, headers: { "Content-Type": "text/plain" } }) }, new URL("http://nomad:4646"), "secret-acl-token", "global");
      const result = client.request("/v1/jobs/parse", "default", { diagnostics: true }).catch(error => error);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toMatchObject({ status: 400, message: "Nomad request failed (HTTP 400)" });
      expect(cancel).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe("Evaluation references", () => {
  it("rejects a foreign namespace or job in related evaluations", async () => {
    for (const related of [{ ID: "related", Namespace: "private", JobID: "web" }, { ID: "related", Namespace: "team", JobID: "other" }]) {
      const server = await setup({ fetch: async () => Response.json({ ID: "eval", Namespace: "team", JobID: "web", RelatedEvals: [related] }) });
      expect((await server.request("/evaluations/eval?namespace=team")).status).toBe(409);
    }
  });
});
