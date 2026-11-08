import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { identifier, NomadError, nonnegativeInteger } from "./client.js";
import { route, objectBody, listQuery, id, scoped } from "./route-utils.js";

function list(value: unknown): unknown[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new NomadError(502, "Invalid Nomad list response");
  return value;
}

export function registerJobOperationsRoutes(router: Router, ctx: PluginContext): void {
  const root = "/hosts/:hostId";
  for (const resource of ["deployments", "evaluations"] as const) {
    const singular = resource === "deployments" ? "deployment" : "evaluation";
    router.get(`${root}/${resource}`, route(ctx, async (req, client, ns) => {
      const page = await client.page(`/v1/${resource}`, ns, listQuery(req));
      return { ...page, items: page.items.map(value => scoped(value, ns)) };
    }));
    router.get(`${root}/${resource}/:resourceId`, route(ctx, async (req, client, ns) => {
      const detail = scoped(await client.request(`/v1/${singular}/${id(req, "resourceId")}`, ns, singular === "evaluation" ? { query: { related: "true" } } : {}), ns, req.params.resourceId);
      if (singular === "evaluation" && detail.RelatedEvals !== undefined) {
        detail.RelatedEvals = list(detail.RelatedEvals).map(value => {
          const related = scoped(value, ns);
          if (related.JobID !== detail.JobID) throw new NomadError(409, "Nomad related evaluation identity mismatch");
          return related;
        });
      }
      return detail;
    }, "use", true));
    router.get(`${root}/${resource}/:resourceId/allocations`, route(ctx, async (req, client, ns) => {
      const resourceId = id(req, "resourceId");
      scoped(await client.request(`/v1/${singular}/${resourceId}`, ns), ns, req.params.resourceId);
      const path = singular === "deployment" ? `/v1/deployment/allocations/${resourceId}` : `/v1/evaluation/${resourceId}/allocations`;
      return list(await client.request(path, ns)).map(value => {
        const allocation = scoped(value, ns);
        if (allocation[singular === "deployment" ? "DeploymentID" : "EvalID"] !== req.params.resourceId) throw new NomadError(409, "Nomad allocation identity mismatch");
        return allocation;
      });
    }, "use", true));
  }
  for (const resource of ["deployments", "evaluations", "services"] as const) {
    router.get(`${root}/jobs/:jobId/${resource}`, route(ctx, async (req, client, ns) => {
      const jobId = id(req, "jobId");
      scoped(await client.request(`/v1/job/${jobId}`, ns), ns, req.params.jobId);
      return list(await client.request(`/v1/job/${jobId}/${resource}`, ns)).map(value => {
        const object = scoped(value, ns);
        if (object.JobID !== req.params.jobId) throw new NomadError(409, "Nomad job identity mismatch");
        return object;
      });
    }, "use", true));
  }
  router.get(`${root}/jobs/:jobId/versions`, route(ctx, async (req, client, ns) => {
    const jobId = id(req, "jobId");
    scoped(await client.request(`/v1/job/${jobId}`, ns), ns, req.params.jobId);
    const query: Record<string, string> = { diffs: "true" };
    if (req.query.diff_version !== undefined) {
      if (typeof req.query.diff_version !== "string" || !/^\d+$/.test(req.query.diff_version)) throw new NomadError(400, "Invalid diff version");
      query.diff_version = String(nonnegativeInteger(Number(req.query.diff_version), "Diff version"));
    }
    const result = await client.request(`/v1/job/${jobId}/versions`, ns, { query });
    if (!result || typeof result !== "object" || Array.isArray(result) || !("Versions" in result)) throw new NomadError(502, "Invalid Nomad versions response");
    return { ...result, Versions: list(result.Versions).map(value => scoped(value, ns, req.params.jobId)) };
  }, "use", true));
  router.post(`${root}/jobs/:jobId/revert`, route(ctx, async (req, client, ns) => {
    const jobId = id(req, "jobId");
    const input = objectBody(req);
    const version = nonnegativeInteger(input.version, "Version");
    const prior = nonnegativeInteger(input.enforcePriorVersion, "Prior version");
    const job = scoped(await client.request(`/v1/job/${jobId}`, ns), ns, req.params.jobId);
    if (job.Version !== prior) throw new NomadError(409, "Job version changed; refresh before reverting");
    return client.request(`/v1/job/${jobId}/revert`, ns, { method: "PUT", body: { JobID: req.params.jobId, JobVersion: version, EnforcePriorVersion: prior } });
  }, "manage", true));
  for (const action of ["dispatch", "periodic-force", "evaluate", "purge"] as const) {
    router.post(`${root}/jobs/:jobId/${action}`, route(ctx, async (req, client, ns) => {
      const jobId = id(req, "jobId");
      const job = scoped(await client.request(`/v1/job/${jobId}`, ns), ns, req.params.jobId);
      if (action === "purge") return client.request(`/v1/job/${jobId}`, ns, { method: "DELETE", query: { purge: "true" } });
      if (action === "periodic-force") {
        if (!job.Periodic) throw new NomadError(400, "Job is not periodic");
        return client.request(`/v1/job/${jobId}/periodic/force`, ns, { method: "PUT" });
      }
      const input = objectBody(req);
      if (action === "evaluate") {
        if (typeof input.forceReschedule !== "boolean") throw new NomadError(400, "Force reschedule must be a boolean");
        return client.request(`/v1/job/${jobId}/evaluate`, ns, { method: "PUT", body: { JobID: req.params.jobId, EvalOptions: { ForceReschedule: input.forceReschedule } } });
      }
      if (!job.ParameterizedJob) throw new NomadError(400, "Job is not parameterized");
      if (!input.meta || typeof input.meta !== "object" || Array.isArray(input.meta) || Object.values(input.meta).some(value => typeof value !== "string")) throw new NomadError(400, "Dispatch metadata must contain string values");
      if (typeof input.payload !== "string" || Buffer.byteLength(input.payload) > 16 * 1024) throw new NomadError(400, "Dispatch payload must be text up to 16 KiB");
      const prefix = input.idPrefix === "" || input.idPrefix === undefined ? "" : identifier(input.idPrefix, "dispatch ID prefix");
      return client.request(`/v1/job/${jobId}/dispatch`, ns, { method: "PUT", body: { JobID: req.params.jobId, Meta: input.meta, Payload: Buffer.from(input.payload).toString("base64"), IdPrefixTemplate: prefix } });
    }, "manage", true));
  }
  for (const action of ["promote", "fail", "pause", "resume", "unblock"] as const) {
    router.post(`${root}/deployments/:deploymentId/${action}`, route(ctx, async (req, client, ns) => {
      const deploymentId = id(req, "deploymentId");
      const deployment = scoped(await client.request(`/v1/deployment/${deploymentId}`, ns), ns, req.params.deploymentId);
      const body: Record<string, unknown> = { DeploymentID: req.params.deploymentId };
      if (action === "pause" || action === "resume") body.Pause = action === "pause";
      if (action === "promote") {
        const input = objectBody(req);
        if (!Array.isArray(input.groups) || input.groups.some(group => typeof group !== "string")) throw new NomadError(400, "Promotion groups must be an array");
        const groups = input.groups as string[];
        const taskGroups = deployment.TaskGroups;
        if (groups.some(group => !taskGroups || typeof taskGroups !== "object" || !Object.hasOwn(taskGroups, group))) throw new NomadError(400, "Unknown deployment task group");
        if (groups.length) body.Groups = groups;
        else body.All = true;
      }
      return client.request(`/v1/deployment/${action === "resume" ? "pause" : action}/${deploymentId}`, ns, { method: "PUT", body });
    }, "manage", true));
  }
}
