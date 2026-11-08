import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { PluginContext, PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import { registerConsulRoutes } from "../../src/backend/consul-routes.js";

const ALLOCATION = "b624a02d-5cbb-4517-8075-c239f58e7698";
const FOREIGN = "a9676807-02d2-4192-88fc-f944c1f22dc5";
const SERVICE = `_nomad-task-${ALLOCATION}-web-shared-http`;
const job = { ID: "demo", Namespace: "team", TaskGroups: [{ Name: "web", Services: [{ Name: "shared", Provider: "consul" }], Tasks: [{ Name: "server" }] }] };
const allocation = { ID: ALLOCATION, JobID: "demo", Namespace: "team", TaskGroup: "web", DesiredStatus: "run", ClientStatus: "running" };
const check = { CheckID: "service-check", Name: "HTTP", ServiceID: SERVICE, ServiceName: "shared", Node: "worker", Status: "passing", Output: "ready" };
const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(async server => {
    const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed;
  }));
});

type Options = {
  actor?: boolean; use?: boolean; connect?: boolean; enabled?: boolean;
  values?: Record<string, unknown>; job?: unknown; allocations?: unknown; checks?: unknown;
  consul?: PluginFetch;
};
async function setup(options: Options = {}) {
  const values: Record<string, unknown> = {
    enableNomad: options.enabled !== false, address: "https://nomad.internal:4646", region: "global", token: "nomad-secret",
    consulAddress: "https://consul.internal:8501", consulToken: "consul-secret", consulUiUrl: "http://100.88.18.82:8500/ui/", ...options.values,
  };
  const settings = vi.fn(async (_host: number, key: string) => values[key]);
  const host = vi.fn(async () => ({ id: 7, ip: "10.0.0.7" }));
  const upstream = vi.fn<PluginFetch>(async (target, init) => {
    const url = new URL(target);
    if (url.hostname === "nomad.internal") return Response.json(url.pathname.endsWith("/allocations") ? options.allocations ?? [allocation] : options.job ?? job);
    if (options.consul) return options.consul(target, init);
    return Response.json(url.pathname === "/v1/status/leader" ? "10.0.0.9:8300" : options.checks ?? [check]);
  });
  const ctx = {
    fetch: upstream, currentActor: () => options.actor === false ? null : "actor",
    hosts: { get: host, checkAccess: async () => ({ hasAccess: options.connect !== false }) }, settings: { getHost: settings },
    rbac: { has: async (permission: string) => permission === "use" && options.use !== false },
  } as unknown as PluginContext;
  const app = express(); registerConsulRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1"); servers.push(server); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hosts/7`;
  const request = (path = "/jobs/demo/consul?namespace=team") => fetch(base + path);
  const consulCalls = () => upstream.mock.calls.filter(([url]) => new URL(url).hostname !== "nomad.internal");
  return { request, settings, host, upstream, consulCalls };
}

const consulSettings = (app: { settings: { mock: { calls: [number, string][] } } }) => app.settings.mock.calls.filter(([, key]) => key.startsWith("consul"));

describe("Consul authorization and scope", () => {
  it.each(["/consul", "/jobs/demo/consul?namespace=team"])("authorizes before reading credentials on %s", async path => {
    for (const [options, status] of [[{ actor: false }, 401], [{ use: false }, 403], [{ connect: false }, 403]] as const) {
      const app = await setup(options);
      expect((await app.request(path)).status).toBe(status);
      expect(app.settings).not.toHaveBeenCalled(); expect(app.upstream).not.toHaveBeenCalled();
      if (!("connect" in options)) expect(app.host).not.toHaveBeenCalled();
    }
  });
  it("requires Nomad enablement and a concrete namespace before Consul credentials", async () => {
    const disabled = await setup({ enabled: false });
    expect((await disabled.request("/consul")).status).toBe(403); expect(consulSettings(disabled)).toEqual([]);
    const wildcard = await setup();
    expect((await wildcard.request("/jobs/demo/consul?namespace=*")).status).toBe(400);
    expect(wildcard.settings).not.toHaveBeenCalled(); expect(wildcard.upstream).not.toHaveBeenCalled();
  });
  it.each([{ ...job, ID: "foreign" }, { ...job, Namespace: "private" }])("rejects mismatched job identity before Consul settings", async response => {
    const app = await setup({ job: response });
    expect((await app.request()).status).toBe(409); expect(consulSettings(app)).toEqual([]); expect(app.consulCalls()).toEqual([]);
    expect(app.upstream).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...allocation, JobID: "foreign" }, { ...allocation, Namespace: "private" }, { ...allocation, Namespace: "private", DesiredStatus: "stop" }])("rejects every mismatched allocation before Consul settings", async response => {
    const app = await setup({ allocations: [allocation, response] });
    expect((await app.request()).status).toBe(409); expect(consulSettings(app)).toEqual([]); expect(app.consulCalls()).toEqual([]);
  });
  it.each([{ ...allocation, ID: "not-a-uuid" }, { ...allocation, TaskGroup: "foreign" }])("refuses malformed allocation ownership data", async response => {
    const app = await setup({ allocations: [response] });
    expect((await app.request()).status).toBe(502); expect(consulSettings(app)).toEqual([]); expect(app.consulCalls()).toEqual([]);
  });
  it("scopes both Nomad reads but never forwards Nomad namespace, region or token to Consul", async () => {
    const app = await setup(); await app.request();
    const nomad = app.upstream.mock.calls.filter(([target]) => new URL(target).hostname === "nomad.internal");
    expect(nomad).toHaveLength(2);
    expect(new URL(nomad[0]![0]).searchParams.get("namespace")).toBe("team");
    expect(Object.fromEntries(new URL(nomad[1]![0]).searchParams)).toEqual({ namespace: "team", region: "global", all: "false" });
    const [target, init] = app.consulCalls()[0]!;
    expect(new URL(target).search).toBe("");
    expect(init?.headers).toEqual({ Accept: "application/json", "X-Consul-Token": "consul-secret" });
  });
});

describe("Consul configuration and transport", () => {
  it("disables absent settings without reading the Consul token or calling its API", async () => {
    const app = await setup({ values: { consulAddress: "" } });
    expect(await (await app.request("/consul")).json()).toEqual({ configured: false, status: "unconfigured" });
    expect(await (await app.request()).json()).toMatchObject({ configured: false, status: "unconfigured", usesConsul: true, health: "unknown", expectedServices: 1, checks: [], error: expect.stringContaining("Configure") });
    expect(app.settings.mock.calls.some(([, key]) => key === "consulToken")).toBe(false); expect(app.consulCalls()).toEqual([]);
  });
  it("returns only the configured browser link without requiring a Consul connection", async () => {
    const app = await setup({ values: { consulAddress: "", nomadUiUrl: "http://100.88.18.82:4646/ui/" } });
    expect(await (await app.request("/consul")).json()).toMatchObject({ configured: false, status: "unconfigured", nomadUiUrl: "http://100.88.18.82:4646/ui/" });
    expect(app.upstream).not.toHaveBeenCalled();
    expect(app.settings.mock.calls.some(([, key]) => key === "consulToken")).toBe(false);
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "http://user:secret@nomad.example/ui/", "https://nomad.example/ui/?token=secret", "https://nomad.example/ui/#secret", "//nomad.example/ui/", "http://nomad.example\n.evil", 42])("omits unsafe Nomad UI URLs without leaking credentials: %s", async nomadUiUrl => {
    const app = await setup({ values: { nomadUiUrl } });
    expect(await (await app.request("/consul")).json()).not.toHaveProperty("nomadUiUrl");
    expect(await (await app.request()).json()).not.toHaveProperty("nomadUiUrl");
  });
  it("bypasses all Consul settings for a native-only job", async () => {
    const native = { ...job, TaskGroups: [{ Name: "web", Services: [{ Provider: "nomad" }], Tasks: [{ Services: [{ Provider: "nomad" }] }] }] };
    const app = await setup({ job: native });
    expect(await (await app.request()).json()).toEqual({ configured: false, status: "unconfigured", usesConsul: false, health: "not-applicable", checks: [], expectedServices: 0, partial: false });
    expect(consulSettings(app)).toEqual([]); expect(app.upstream).toHaveBeenCalledTimes(1);
  });
  it("uses only the configured host, fixed paths, verified TLS and redirect rejection", async () => {
    const app = await setup({ values: { consulAddress: "https://consul.internal:8501/ignored/base" } });
    expect(await (await app.request("/consul?address=http://evil&token=attacker&namespace=private")).json()).toEqual({ configured: true, status: "connected", uiUrl: "http://100.88.18.82:8500/ui/" });
    const [target, init] = app.consulCalls()[0]!;
    expect(target).toBe("https://consul.internal:8501/v1/status/leader");
    expect(init).toMatchObject({ method: "GET", redirect: "error", tls: { rejectUnauthorized: true }, allowPrivateHosts: ["consul.internal"], timeoutMs: 10_000 });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(["file:///etc/passwd", "javascript:alert(1)", "http://user:secret@consul.internal", "http://consul.internal/?token=secret", "http://consul.internal/#secret", "http://consul.internal\n.evil", 42])("rejects unsafe configured API addresses: %s", async consulAddress => {
    const app = await setup({ values: { consulAddress } });
    expect(await (await app.request("/consul")).json()).toMatchObject({ configured: true, status: "error", error: "Invalid Consul address setting" });
    expect(app.consulCalls()).toEqual([]); expect(app.settings.mock.calls.some(([, key]) => key === "consulToken")).toBe(false);
  });
  it.each([undefined, "", "javascript:alert(1)", "data:text/html,x", "http://user:secret@ui.internal/ui/", "https://ui.internal/ui/?token=secret", "https://ui.internal/ui/#secret", "//ui.internal/ui/"])("omits absent or unsafe browser URLs without inventing one: %s", async consulUiUrl => {
    const app = await setup({ values: { consulUiUrl } });
    expect(await (await app.request("/consul")).json()).toEqual({ configured: true, status: "connected" });
    expect(await (await app.request()).json()).not.toHaveProperty("uiUrl");
  });
  it.each(["", "  ", null, { leader: "10.0.0.1:8300" }])("does not claim an absent or invalid leader is connected", async leader => {
    const app = await setup({ consul: async () => Response.json(leader) });
    expect(await (await app.request("/consul")).json()).toMatchObject({ status: "error", error: "Consul has no elected leader" });
  });
  it("does not borrow the Nomad token when a Consul token is absent", async () => {
    const app = await setup({ values: { consulToken: undefined } }); await app.request("/consul");
    expect(app.consulCalls()[0]![1]?.headers).toEqual({ Accept: "application/json" });
  });
  it.each([403, 500])("retains the safe UI URL on HTTP %s without leaking response secrets", async status => {
    const cancel = vi.fn();
    const app = await setup({ consul: async () => new Response(new ReadableStream({ cancel }), { status }) });
    const result = await (await app.request()).json();
    expect(result).toMatchObject({ configured: true, status: "error", health: "unknown", checks: [], uiUrl: "http://100.88.18.82:8500/ui/", error: `Consul request failed (HTTP ${status})` });
    expect(cancel).toHaveBeenCalled();
  });
  it("sanitizes transport exceptions including a refused SSRF target", async () => {
    const app = await setup({ consul: async () => { throw new Error("SSRF refused http://consul-secret@private/ nomad-secret"); } });
    for (const path of ["/consul", "/jobs/demo/consul?namespace=team"]) {
      const body = await (await app.request(path)).text();
      expect(body).toContain("Unable to contact Consul"); expect(body).not.toContain("consul-secret"); expect(body).not.toContain("nomad-secret"); expect(body).not.toContain("private/");
    }
  });
  it("rejects oversized health responses and cancels instead of returning an empty passing result", async () => {
    const cancel = vi.fn();
    const app = await setup({ consul: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel })) });
    expect(await (await app.request()).json()).toMatchObject({ status: "error", health: "unknown", checks: [], error: "Consul response exceeds the size limit" });
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects invalid JSON instead of synthesizing healthy checks", async () => {
    const app = await setup({ consul: async () => new Response("consul-secret not JSON") });
    expect(await (await app.request()).json()).toMatchObject({ status: "error", health: "unknown", error: "Consul returned invalid JSON" });
  });
  it("bounds a stalled streamed body with a deadline and cancels the reader", async () => {
    const requested = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const app = await setup({ consul: async () => {
      requested.resolve();
      return new Response(new ReadableStream({ cancel }));
    } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = app.request();
    await requested.promise;
    await vi.advanceTimersByTimeAsync(10_001);
    vi.useRealTimers();
    expect(await (await response).json()).toMatchObject({ status: "error", health: "unknown", error: "Consul request timed out" });
    expect(cancel).toHaveBeenCalled();
  });
});

describe("Allocation-scoped Consul health", () => {
  it("returns only exact allocation registrations even when foreign jobs use the same service name", async () => {
    const foreign = { ...check, CheckID: "foreign-secret-check", ServiceID: `_nomad-task-${FOREIGN}-web-shared-http`, Output: "private output" };
    const prefixCollision = { ...check, CheckID: "collision", ServiceID: `_nomad-task-${ALLOCATION}evil-web-shared-http`, Output: "collision output" };
    const nodeCheck = { ...check, CheckID: "serfHealth", ServiceID: "", Output: "private node output" };
    const app = await setup({ checks: [foreign, prefixCollision, nodeCheck, check] });
    expect(await (await app.request()).json()).toMatchObject({ status: "connected", health: "passing", expectedServices: 1, partial: false, checks: [{ id: "service-check", name: "HTTP", serviceId: SERVICE, serviceName: "shared", node: "worker", status: "passing", output: "ready" }] });
  });
  it.each(["critical", "warning", "maintenance"])("accounts for associated node status %s without exposing node check data", async Status => {
    const app = await setup({ checks: [{ ...check, CheckID: "serfHealth", ServiceID: "", Status, Output: "private node output" }, check] });
    const result = await (await app.request()).json();
    expect(result).toMatchObject({ health: Status === "maintenance" ? "unknown" : Status, checks: [expect.objectContaining({ id: "service-check", status: "passing" })] });
    expect(JSON.stringify(result)).not.toContain("serfHealth"); expect(JSON.stringify(result)).not.toContain("private node output");
  });
  it("does not use unrelated node failures to mark this job unhealthy", async () => {
    const app = await setup({ checks: [{ ...check, CheckID: "serfHealth", ServiceID: "", Node: "foreign-node", Status: "critical", Output: "private foreign output" }, check] });
    expect(await (await app.request()).json()).toMatchObject({ health: "passing", checks: [expect.objectContaining({ id: "service-check" })] });
  });
  it("accepts the observed Nomad group registration without assuming the CheckID contains an allocation", async () => {
    const uuid = "bd88b95f-617e-f84a-af93-5338481ec9e9";
    const serviceId = `_nomad-task-${uuid}-group-web-termix-consul-demo-http`;
    const checkId = "_nomad-check-dc2f82aa7f014edb83a026e2e83af7e0d6b5179ca82c90f04dab6f18ed054f6e";
    const app = await setup({
      job: { ...job, ID: "termix-consul-demo", Namespace: "default" },
      allocations: [{ ...allocation, ID: uuid, JobID: "termix-consul-demo", Namespace: "default" }],
      checks: [{ ...check, CheckID: checkId, ServiceID: serviceId }],
    });
    expect(await (await app.request("/jobs/termix-consul-demo/consul")).json()).toMatchObject({ health: "passing", checks: [expect.objectContaining({ id: checkId, serviceId })] });
  });
  it.each([
    [["passing"], "passing"], [["passing", "warning"], "warning"], [["warning", "critical"], "critical"], [["unknown"], "unknown"], [["maintenance"], "unknown"], [[], "unknown"],
  ])("aggregates observed states %j as %s", async (states, health) => {
    const app = await setup({ checks: (states as string[]).map((Status, index) => ({ ...check, CheckID: String(index), Status })) });
    expect(await (await app.request()).json()).toMatchObject({ health, partial: (states as string[]).length === 0 });
  });
  it("counts group and task Consul declarations, including the absent default, but excludes native services", async () => {
    const mixed = { ...job, TaskGroups: [{ Name: "web", Services: [{ Name: "group" }, { Provider: "nomad" }], Tasks: [{ Services: [{ Name: "task", Provider: "consul" }, { Name: "default" }, { Provider: "nomad" }] }] }] };
    const app = await setup({ job: mixed, checks: [check, { ...check, ServiceID: SERVICE + "-2" }, { ...check, ServiceID: SERVICE + "-3" }] });
    expect(await (await app.request()).json()).toMatchObject({ usesConsul: true, expectedServices: 3, partial: false, health: "passing" });
  });
  it("requires coverage per allocation rather than allowing extra checks from one allocation to hide missing services", async () => {
    const app = await setup({ allocations: [allocation, { ...allocation, ID: FOREIGN }], checks: [check, { ...check, CheckID: "another-check" }] });
    expect(await (await app.request()).json()).toMatchObject({ expectedServices: 2, partial: true, health: "unknown" });
  });
  it("keeps a service with no own check unknown instead of using node checks or allocation running status", async () => {
    const app = await setup({ checks: [{ ...check, ServiceID: "", CheckID: "serfHealth" }] });
    expect(await (await app.request()).json()).toMatchObject({ expectedServices: 1, partial: true, health: "unknown", checks: [] });
  });
  it.each([{ allocations: [] }, { allocations: [{ ...allocation, DesiredStatus: "stop" }] }, { allocations: [{ ...allocation, ClientStatus: "complete" }] }])("keeps no active allocations unknown and excludes retired checks", async ({ allocations }) => {
    const app = await setup({ allocations });
    expect(await (await app.request()).json()).toMatchObject({ expectedServices: 0, health: "unknown", checks: [], error: "No active Nomad allocations with Consul services." });
  });
  it("ignores retired allocation registrations without counting them as missing current services", async () => {
    const app = await setup({ allocations: [allocation, { ...allocation, ID: FOREIGN, DesiredStatus: "stop", ClientStatus: "complete" }], checks: [check, { ...check, ServiceID: `_nomad-task-${FOREIGN}-group-web-shared-http`, Status: "critical" }] });
    expect(await (await app.request()).json()).toMatchObject({ expectedServices: 1, partial: false, health: "passing", checks: [expect.objectContaining({ serviceId: SERVICE })] });
  });
  it("counts only allocations in groups that declare Consul services", async () => {
    const mixed = { ...job, TaskGroups: [...job.TaskGroups, { Name: "native", Services: [{ Name: "native", Provider: "nomad" }], Tasks: [] }] };
    const app = await setup({ job: mixed, allocations: [allocation, { ...allocation, ID: FOREIGN, TaskGroup: "native" }], checks: [check, { ...check, ServiceID: `_nomad-task-${FOREIGN}-native`, Output: "not ours" }] });
    expect(await (await app.request()).json()).toMatchObject({ expectedServices: 1, partial: false, health: "passing", checks: [expect.objectContaining({ serviceId: SERVICE })] });
  });
  it.each(["passing", "warning", "critical"])("marks ACL-filtered %s results partial without hiding observed failures", async Status => {
    const app = await setup({ consul: async () => Response.json([{ ...check, Status }], { headers: { "X-Consul-Results-Filtered-By-ACLs": "true" } }) });
    expect(await (await app.request()).json()).toMatchObject({ health: Status === "passing" ? "unknown" : Status, partial: true, checks: [expect.objectContaining({ status: Status })] });
  });
  it("keeps an HTTP 200 empty ACL-filtered response unknown", async () => {
    const app = await setup({ consul: async () => Response.json([], { headers: { "X-Consul-Results-Filtered-By-ACLs": "true" } }) });
    expect(await (await app.request()).json()).toMatchObject({ status: "connected", health: "unknown", checks: [], partial: true });
  });
  it("bounds output and redacts the Consul credential before serialization", async () => {
    const app = await setup({ checks: [{ ...check, Output: "consul-secret " + "x".repeat(5000) }] });
    const result = await (await app.request()).json();
    expect(result.checks[0].output).toContain("[redacted]"); expect(JSON.stringify(result)).not.toContain("consul-secret");
    expect(Buffer.byteLength(result.checks[0].output)).toBeLessThanOrEqual(1024);
  });
  it("never treats malformed health data as complete passing coverage", async () => {
    const app = await setup({ checks: [check, { ServiceID: SERVICE, CheckID: "bad" }] });
    expect(await (await app.request()).json()).toMatchObject({ partial: true, health: "unknown" });
    const wrongShape = await setup({ checks: { Status: "passing" } });
    expect(await (await wrongShape.request()).json()).toMatchObject({ status: "error", health: "unknown", error: "Consul returned an invalid health list" });
  });
  it("uses a single constant-size Consul request for many authorized allocations", async () => {
    const allocations = Array.from({ length: 300 }, (_, index) => ({ ...allocation, ID: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    const app = await setup({ allocations, checks: [] });
    expect(await (await app.request()).json()).toMatchObject({ expectedServices: 300, health: "unknown", partial: true });
    expect(app.consulCalls()).toHaveLength(1); expect(app.consulCalls()[0]![0]).toBe("https://consul.internal:8501/v1/health/state/any");
  });
});
