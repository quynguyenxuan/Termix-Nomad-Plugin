import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { identifier, NomadError, nonnegativeInteger } from "./client.js";
import { id, listQuery, objectBody, route, scoped, streamResponse } from "./route-utils.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NomadError(502, "Invalid Nomad object response");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new NomadError(502, "Invalid Nomad list response");
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new NomadError(400, `${label} must be boolean`);
  return value;
}
function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(item => typeof item !== "string")) throw new NomadError(400, "Metadata must be an object of strings");
  return value as Record<string, string>;
}
function poolInput(input: Record<string, unknown>, expectedName?: string): Record<string, unknown> {
  const name = identifier(input.Name, "node pool name");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) throw new NomadError(400, "Invalid node pool name");
  if (expectedName !== undefined && name !== expectedName) throw new NomadError(400, "Node pool name must match the selected pool");
  if (name === "all") throw new NomadError(400, "The all node pool is read-only");
  const description = input.Description ?? "";
  if (typeof description !== "string" || description.length > 4096) throw new NomadError(400, "Description must be a string of at most 4096 characters");
  const result: Record<string, unknown> = { Name: name, Description: description, Meta: stringMap(input.Meta ?? {}) };
  if (input.NodeIdentityTTL !== undefined) {
    if (typeof input.NodeIdentityTTL !== "string" || input.NodeIdentityTTL.length > 128) throw new NomadError(400, "Node identity TTL must be a duration string");
    result.NodeIdentityTTL = input.NodeIdentityTTL;
  }
  if (input.SchedulerConfiguration != null) {
    const value = input.SchedulerConfiguration;
    if (typeof value !== "object" || Array.isArray(value)) throw new NomadError(400, "Invalid scheduler configuration");
    const config = value as Record<string, unknown>;
    if (config.SchedulerAlgorithm !== "binpack" && config.SchedulerAlgorithm !== "spread") throw new NomadError(400, "Scheduler algorithm must be binpack or spread");
    result.SchedulerConfiguration = { SchedulerAlgorithm: config.SchedulerAlgorithm, ...(config.MemoryOversubscriptionEnabled == null ? {} : { MemoryOversubscriptionEnabled: boolean(config.MemoryOversubscriptionEnabled, "Memory oversubscription") }) };
  }
  if (input.BatchQueueConfig !== undefined) {
    if (input.BatchQueueConfig !== null && (typeof input.BatchQueueConfig !== "object" || Array.isArray(input.BatchQueueConfig))) throw new NomadError(400, "Invalid batch queue configuration");
    result.BatchQueueConfig = input.BatchQueueConfig;
  }
  return result;
}

export function registerClusterRoutes(router: Router, ctx: PluginContext): void {
  const root = "/hosts/:hostId";
  router.get(`${root}/nodes`, route(ctx, async (req, client, ns) => client.page("/v1/nodes", ns, { ...listQuery(req), resources: "true" })));
  router.get(`${root}/node-list`, route(ctx, async (_req, client, ns) => array(await client.request("/v1/nodes", ns))));
  router.get(`${root}/dashboard/allocations`, route(ctx, async (req, client, ns) => {
    const page = await client.page("/v1/allocations", ns, { ...listQuery(req), resources: "true", task_states: "false" });
    return { ...page, items: page.items.map(value => scoped(value, ns)) };
  }));
  router.get(`${root}/nodes/:nodeId`, route(ctx, async (req, client, ns) => {
    const node = object(await client.request(`/v1/node/${id(req, "nodeId")}`, ns));
    if (node.ID !== req.params.nodeId) throw new NomadError(409, "Nomad node identity mismatch");
    return node;
  }));
  router.get(`${root}/nodes/:nodeId/stats`, route(ctx, async (req, client, ns) => {
    const node = object(await client.request(`/v1/node/${id(req, "nodeId")}`, ns));
    if (node.ID !== req.params.nodeId) throw new NomadError(409, "Nomad node identity mismatch");
    return client.request("/v1/client/stats", ns, { query: { node_id: req.params.nodeId! } });
  }));
  router.get(`${root}/nodes/:nodeId/monitor`, route(ctx, async (req, client, ns, res) => {
    const node = object(await client.request(`/v1/node/${id(req, "nodeId")}`, ns));
    if (node.ID !== req.params.nodeId) throw new NomadError(409, "Nomad node identity mismatch");
    const level = req.query.level ?? "info";
    if (typeof level !== "string" || !["trace", "debug", "info", "warn", "error"].includes(level)) throw new NomadError(400, "Invalid log level");
    await streamResponse(req, res, client, "/v1/agent/monitor", ns, { client_id: req.params.nodeId!, log_level: level, plain: "true" });
  }, "administer"));
  router.get(`${root}/nodes/:nodeId/allocations`, route(ctx, async (req, client, ns) => array(await client.request(`/v1/node/${id(req, "nodeId")}/allocations`, ns)).map(value => {
    const allocation = scoped(value, ns);
    if (allocation.NodeID !== req.params.nodeId) throw new NomadError(409, "Nomad allocation node mismatch");
    return allocation;
  })));
  router.put(`${root}/nodes/:nodeId/drain`, route(ctx, async (req, client, ns) => {
    const path = `/v1/node/${id(req, "nodeId")}`;
    const input = objectBody(req);
    const enabled = boolean(input.enabled, "Enabled");
    const node = object(await client.request(path, ns));
    if (node.ID !== req.params.nodeId) throw new NomadError(409, "Nomad node identity mismatch");
    let spec: Record<string, unknown> | null = null;
    if (enabled) {
      const seconds = nonnegativeInteger(input.deadlineSeconds, "Drain deadline seconds");
      if (!Number.isSafeInteger(seconds * 1_000_000_000)) throw new NomadError(400, "Drain deadline exceeds the safe duration range");
      spec = { Deadline: seconds * 1_000_000_000, IgnoreSystemJobs: boolean(input.ignoreSystemJobs, "Ignore system jobs") };
    }
    return client.request(`${path}/drain`, ns, { method: "PUT", body: { NodeID: node.ID, DrainSpec: spec, MarkEligible: boolean(input.markEligible, "Mark eligible"), Meta: { source: "Termix" } } });
  }, "administer"));
  router.put(`${root}/nodes/:nodeId/eligibility`, route(ctx, async (req, client, ns) => {
    const path = `/v1/node/${id(req, "nodeId")}`;
    const eligible = boolean(objectBody(req).eligible, "Eligible");
    const node = object(await client.request(path, ns));
    if (node.ID !== req.params.nodeId) throw new NomadError(409, "Nomad node identity mismatch");
    return client.request(`${path}/eligibility`, ns, { method: "PUT", body: { NodeID: node.ID, Eligibility: eligible ? "eligible" : "ineligible" } });
  }, "administer"));
  router.get(`${root}/node-pools`, route(ctx, async (req, client, ns) => client.page("/v1/node/pools", ns, listQuery(req))));
  router.get(`${root}/node-pools/:poolName`, route(ctx, async (req, client, ns) => {
    const pool = object(await client.request(`/v1/node/pool/${id(req, "poolName")}`, ns));
    if (pool.Name !== req.params.poolName) throw new NomadError(409, "Nomad node pool identity mismatch");
    return pool;
  }));
  router.get(`${root}/node-pools/:poolName/nodes`, route(ctx, async (req, client, ns) => client.page(`/v1/node/pool/${id(req, "poolName")}/nodes`, ns, listQuery(req))));
  router.get(`${root}/node-pools/:poolName/jobs`, route(ctx, async (req, client, ns) => {
    const page = await client.page(`/v1/node/pool/${id(req, "poolName")}/jobs`, ns, listQuery(req));
    return { ...page, items: page.items.map(value => scoped(value, ns)) };
  }));
  router.put(`${root}/node-pools`, route(ctx, async (req, client, ns) => client.request("/v1/node/pools", ns, { method: "PUT", body: poolInput(objectBody(req)) }), "administer"));
  router.put(`${root}/node-pools/:poolName`, route(ctx, async (req, client, ns) => {
    id(req, "poolName");
    return client.request("/v1/node/pools", ns, { method: "PUT", body: poolInput(objectBody(req), req.params.poolName) });
  }, "administer"));
  router.delete(`${root}/node-pools/:poolName`, route(ctx, async (req, client, ns) => {
    const name = id(req, "poolName");
    if (name === "all" || name === "default") throw new NomadError(400, "Built-in node pools cannot be deleted");
    return client.request(`/v1/node/pool/${name}`, ns, { method: "DELETE" });
  }, "administer"));
  router.get(`${root}/servers`, route(ctx, async (_req, client, ns) => array(object(await client.request("/v1/agent/members", ns)).Members), "administer"));
  router.get(`${root}/servers/raft`, route(ctx, async (_req, client, ns) => client.request("/v1/operator/raft/configuration", ns), "administer"));
  router.get(`${root}/servers/leader`, route(ctx, async (_req, client, ns) => ({ leader: await client.request("/v1/status/leader", ns) }), "administer"));
  router.get(`${root}/servers/:serverId/monitor`, route(ctx, async (req, client, ns, res) => {
    id(req, "serverId");
    const level = req.query.level ?? "info";
    if (typeof level !== "string" || !["trace", "debug", "info", "warn", "error"].includes(level)) throw new NomadError(400, "Invalid monitor log level");
    const members = array(object(await client.request("/v1/agent/members", ns)).Members);
    if (!members.some(value => object(value).Name === req.params.serverId)) throw new NomadError(404, "Server not found in configured cluster");
    await streamResponse(req, res, client, "/v1/agent/monitor", ns, { server_id: req.params.serverId!, log_level: level, plain: "true" });
  }, "administer"));
  router.get(`${root}/agent/self`, route(ctx, async (_req, client, ns) => {
    const self = object(await client.request("/v1/agent/self", ns));
    // Agent config may contain credentials; diagnostic views only need membership and statistics.
    return { member: self.member, stats: self.stats };
  }, "administer"));
  router.get(`${root}/agent/metrics`, route(ctx, async (_req, client, ns) => client.request("/v1/metrics", ns), "administer"));
}
