import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Router } from "express";
import { NomadError } from "./client.js";
import { id, route, scoped } from "./route-utils.js";

type ObjectValue = Record<string, unknown>;
type ConsulCheck = { id: string; name: string; serviceId: string; serviceName: string; node: string; status: string; output?: string };
type Configuration = { configured: boolean; address?: URL; uiUrl?: string; nomadUiUrl?: string; error?: string };
const MAX_RESPONSE = 4 * 1024 * 1024;
const ALLOCATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class ConsulError extends Error {}

function safeUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20\x7f?#]/.test(value)) return;
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url;
  } catch { /* Invalid settings are never used as request targets or links. */ }
}

async function configuration(ctx: PluginContext, hostId: number): Promise<Configuration> {
  const nomadUiUrl = safeUrl(await ctx.settings.getHost<unknown>(hostId, "nomadUiUrl"))?.href;
  const value = await ctx.settings.getHost<unknown>(hostId, "consulAddress");
  if (value == null || value === "") return { configured: false, ...(nomadUiUrl ? { nomadUiUrl } : {}) };
  const uiUrl = safeUrl(await ctx.settings.getHost<unknown>(hostId, "consulUiUrl"))?.href;
  const address = safeUrl(value);
  const base = { configured: true, ...(uiUrl ? { uiUrl } : {}), ...(nomadUiUrl ? { nomadUiUrl } : {}) };
  return address ? { ...base, address } : { ...base, error: "Invalid Consul address setting" };
}

async function consulRead(ctx: PluginContext, hostId: number, address: URL, path: "/v1/status/leader" | "/v1/health/state/any"): Promise<{ value: unknown; partial: boolean; token: string }> {
  const setting = await ctx.settings.getHost<unknown>(hostId, "consulToken");
  if (setting != null && typeof setting !== "string") throw new ConsulError("Invalid Consul token setting");
  const token = typeof setting === "string" ? setting : "";
  const url = new URL(address.href);
  url.pathname = path;
  const controller = new AbortController();
  const { promise: stopped, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => { controller.abort(); reject(new ConsulError("Consul request timed out")); }, 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([ctx.fetch(url.href, {
      method: "GET", redirect: "error", timeoutMs: 10_000, signal: controller.signal,
      tls: { rejectUnauthorized: true }, allowPrivateHosts: [url.hostname],
      headers: { Accept: "application/json", ...(token ? { "X-Consul-Token": token } : {}) },
    }), stopped]);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new ConsulError(`Consul request failed (HTTP ${response.status})`);
    }
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) throw new ConsulError("Consul response exceeds the size limit");
      chunks.push(value);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
    catch { throw new ConsulError("Consul returned invalid JSON"); }
    return { value, partial: response.headers.get("X-Consul-Results-Filtered-By-ACLs")?.toLowerCase() === "true", token };
  } catch (error) {
    throw error instanceof ConsulError ? error : new ConsulError(controller.signal.aborted ? "Consul request timed out" : "Unable to contact Consul");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

function objects(value: unknown): ObjectValue[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new NomadError(502, "Invalid Nomad service or allocation list");
  return value as ObjectValue[];
}

function serviceCount(group: ObjectValue): number {
  const services = [...objects(group.Services), ...objects(group.Tasks).flatMap(task => objects(task.Services))];
  return services.filter(service => service.Provider == null || service.Provider === "" || service.Provider === "consul").length;
}

export function registerConsulRoutes(router: Router, ctx: PluginContext): void {
  const root = "/hosts/:hostId";
  router.get(`${root}/consul`, route(ctx, async req => {
    const config = await configuration(ctx, Number(req.params.hostId));
    const base = { configured: config.configured, ...(config.uiUrl ? { uiUrl: config.uiUrl } : {}), ...(config.nomadUiUrl ? { nomadUiUrl: config.nomadUiUrl } : {}) };
    if (!config.configured) return { ...base, status: "unconfigured" };
    if (!config.address) return { ...base, status: "error", error: config.error };
    try {
      const { value } = await consulRead(ctx, Number(req.params.hostId), config.address, "/v1/status/leader");
      if (typeof value !== "string" || !value.trim()) throw new ConsulError("Consul has no elected leader");
      return { ...base, status: "connected" };
    } catch (error) {
      return { ...base, status: "error", error: error instanceof ConsulError ? error.message : "Unable to read Consul status" };
    }
  }));

  router.get(`${root}/jobs/:jobId/consul`, route(ctx, async (req, client, ns) => {
    const jobId = id(req, "jobId");
    const job = scoped(await client.request(`/v1/job/${jobId}`, ns), ns, req.params.jobId);
    const groups = objects(job.TaskGroups);
    const counts = new Map(groups.map(group => [group.Name, serviceCount(group)]));
    const empty = { usesConsul: true, health: "unknown", checks: [] as ConsulCheck[], expectedServices: 0, partial: false };
    if (![...counts.values()].some(count => count > 0)) return { ...empty, usesConsul: false, health: "not-applicable", configured: false, status: "unconfigured" };
    const allocations = objects(await client.request(`/v1/job/${jobId}/allocations`, ns, { query: { all: "false" } }));
    const expected = new Map<string, number>();
    for (const allocation of allocations) {
      scoped(allocation, ns);
      if (allocation.JobID !== req.params.jobId) throw new NomadError(409, "Nomad allocation does not belong to the requested job");
      if (typeof allocation.ID !== "string" || !ALLOCATION_ID.test(allocation.ID)) throw new NomadError(502, "Invalid Nomad allocation identity");
      if (!counts.has(allocation.TaskGroup)) throw new NomadError(502, "Invalid Nomad allocation task group");
      if (allocation.DesiredStatus !== "run" || ["complete", "failed", "lost"].includes(String(allocation.ClientStatus))) continue;
      const count = counts.get(allocation.TaskGroup)!;
      if (count) expected.set(`_nomad-task-${allocation.ID}-`, count);
    }
    const expectedServices = [...expected.values()].reduce((sum, count) => sum + count, 0);
    const config = await configuration(ctx, Number(req.params.hostId));
    const base = { ...empty, expectedServices, configured: config.configured, ...(config.uiUrl ? { uiUrl: config.uiUrl } : {}), ...(config.nomadUiUrl ? { nomadUiUrl: config.nomadUiUrl } : {}) };
    if (!config.configured) return { ...base, status: "unconfigured", error: "This job uses Consul. Configure the host Consul API address and read-only ACL token to view service health." };
    if (!config.address) return { ...base, status: "error", error: config.error };
    try {
      // shortcut: one bounded CE-default-namespace read; use scoped queries if cluster health outgrows the response limit.
      const result = await consulRead(ctx, Number(req.params.hostId), config.address, "/v1/health/state/any");
      if (!Array.isArray(result.value)) throw new ConsulError("Consul returned an invalid health list");
      const checks: ConsulCheck[] = [];
      const coverage = new Map<string, Set<string>>();
      const nodes = new Set<string>();
      let malformed = false;
      const text = (value: unknown) => {
        const redacted = typeof value === "string" ? (result.token ? value.split(result.token).join("[redacted]") : value) : "";
        return new TextDecoder().decode(Buffer.from(redacted).subarray(0, 1024), { stream: true });
      };
      for (const item of result.value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) { malformed = true; continue; }
        const check = item as ObjectValue;
        if (typeof check.ServiceID !== "string") continue;
        const match = /^_nomad-task-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i.exec(check.ServiceID);
        const prefix = match ? `_nomad-task-${match[1]}-` : "";
        if (!expected.has(prefix)) continue;
        if (typeof check.CheckID !== "string" || !check.CheckID || typeof check.Status !== "string") { malformed = true; continue; }
        const services = coverage.get(prefix) ?? new Set<string>();
        services.add(check.ServiceID); coverage.set(prefix, services);
        if (typeof check.Node === "string" && check.Node) nodes.add(check.Node);
        checks.push({ id: text(check.CheckID), name: text(check.Name), serviceId: text(check.ServiceID), serviceName: text(check.ServiceName), node: text(check.Node), status: text(check.Status), ...(typeof check.Output === "string" ? { output: text(check.Output) } : {}) });
      }
      const nodeStates = new Set<string>();
      for (const item of result.value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const check = item as ObjectValue;
        if (check.ServiceID === "" && typeof check.Node === "string" && nodes.has(check.Node)) nodeStates.add(typeof check.Status === "string" ? check.Status : "unknown");
      }
      const partial = result.partial || malformed || [...expected].some(([prefix, count]) => (coverage.get(prefix)?.size ?? 0) < count);
      const health = nodeStates.has("critical") || checks.some(check => check.status === "critical") ? "critical" : nodeStates.has("warning") || checks.some(check => check.status === "warning") ? "warning" : !checks.length || partial || [...nodeStates].some(status => status !== "passing") || checks.some(check => check.status !== "passing") ? "unknown" : "passing";
      const error = (health === "critical" || health === "warning") && nodeStates.has(health) ? `Consul reports a ${health} node health check for this job's service node.` : health === "unknown" ? expected.size ? "Consul service health is incomplete or unknown." : "No active Nomad allocations with Consul services." : undefined;
      return { ...base, status: "connected", health, checks, partial, ...(error ? { error } : {}) };
    } catch (error) {
      return { ...base, status: "error", error: error instanceof ConsulError ? error.message : "Unable to read Consul service health" };
    }
  }, "use", true));
}
