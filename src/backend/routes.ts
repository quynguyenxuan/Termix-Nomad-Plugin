import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { jobInput, NomadError, nonnegativeInteger } from "./client.js";
import { route, objectBody, listQuery, id, scoped } from "./route-utils.js";

function list(value: unknown): unknown[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new NomadError(502, "Invalid Nomad list response");
  return value;
}

function sourceText(value: unknown, label: string, required = false, status = 400): string {
  if (typeof value !== "string" || (required && !value.trim()) || Buffer.byteLength(value) > 1024 * 1024) throw new NomadError(status, `${label} must be ${required ? "nonempty text" : "text"} of at most 1 MiB`);
  return value;
}

function submissionInput(value: unknown, status = 400): { Source: string; Format: "hcl2" | "json"; Variables?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NomadError(status, "Invalid job submission");
  const input = value as Record<string, unknown>;
  const Source = sourceText(input.Source, "Job source", true, status);
  if (input.Format !== "hcl2" && input.Format !== "json") throw new NomadError(status, "Submission format must be hcl2 or json");
  const Variables = input.Variables === undefined ? undefined : sourceText(input.Variables, "HCL variables", false, status);
  if (input.Format === "json" && Variables) throw new NomadError(status, "HCL variables cannot be used with JSON jobs");
  return { Source, Format: input.Format, ...(Variables === undefined ? {} : { Variables }) };
}

export function registerRoutes(router: Router, ctx: PluginContext): void {
  const root = "/hosts/:hostId";
  router.get(`${root}/status`, route(ctx, async (_req, client, ns) => {
    const leader = await client.request("/v1/status/leader", ns);
    if (typeof leader !== "string") throw new NomadError(502, "Invalid Nomad leader response");
    return { leader };
  }));
  router.get(`${root}/namespaces`, route(ctx, async (_req, client, ns) => list(await client.request("/v1/namespaces", ns))));
  router.get(`${root}/jobs`, route(ctx, async (_req, client, ns) => list(await client.request("/v1/jobs", ns)).map(job => scoped(job, ns))));
  router.get(`${root}/job-list`, route(ctx, async (req, client, ns) => {
    const page = await client.page("/v1/jobs", ns, listQuery(req));
    return { ...page, items: page.items.map(job => scoped(job, ns)) };
  }));
  router.get(`${root}/jobs/:jobId`, route(ctx, async (req, client, ns) => scoped(await client.request(`/v1/job/${id(req, "jobId")}`, ns), ns, req.params.jobId), "use", true));
  router.get(`${root}/jobs/:jobId/allocations`, route(ctx, async (req, client, ns) => {
    const jobId = id(req, "jobId");
    scoped(await client.request(`/v1/job/${jobId}`, ns), ns, req.params.jobId);
    return list(await client.request(`/v1/job/${jobId}/allocations`, ns, { query: { all: "false" } })).map(value => {
      const allocation = scoped(value, ns);
      if (allocation.JobID !== req.params.jobId) throw new NomadError(409, "Nomad allocation job mismatch");
      return allocation;
    });
  }, "use", true));
  router.get(`${root}/jobs/:jobId/submission`, route(ctx, async (req, client, ns) => {
    if (typeof req.query.version !== "string" || !/^\d+$/.test(req.query.version)) throw new NomadError(400, "A nonnegative job version is required");
    const version = nonnegativeInteger(Number(req.query.version), "Job version");
    const jobId = id(req, "jobId");
    scoped(await client.request(`/v1/job/${jobId}`, ns), ns, req.params.jobId);
    let result: unknown;
    try { result = await client.request(`/v1/job/${jobId}/submission`, ns, { query: { version: String(version) } }); }
    catch (error) { if (error instanceof NomadError && error.status === 404) return null; throw error; }
    return result === null ? null : submissionInput(result, 502);
  }, "use", true));
  router.post(`${root}/parse`, route(ctx, async (req, client, ns) => {
    const input = objectBody(req);
    const source = sourceText(input.source, "Job source", true);
    const variables = input.variables === undefined ? "" : sourceText(input.variables, "HCL variables");
    let job: unknown;
    if (input.format === "hcl") job = await client.request("/v1/jobs/parse", ns, { method: "PUT", diagnostics: true, body: { JobHCL: source, Variables: variables, Canonicalize: true } });
    else if (input.format === "json") {
      if (variables) throw new NomadError(400, "HCL variables cannot be used with JSON jobs");
      try { job = JSON.parse(source); }
      catch (error) {
        const location = error instanceof SyntaxError ? /\(line (\d+) column (\d+)\)/.exec(error.message) : null;
        throw new NomadError(400, `Invalid job JSON${location ? ` (line ${location[1]}, column ${location[2]})` : ""}`);
      }
      if (job && typeof job === "object" && "Job" in job) job = job.Job;
    } else throw new NomadError(400, "Format must be hcl or json");
    return jobInput(job, ns, client.region);
  }, "use", true));
  router.post(`${root}/validate`, route(ctx, async (req, client, ns) => {
    const job = jobInput(objectBody(req).job, ns, client.region);
    const result = await client.request("/v1/validate/job", ns, { method: "PUT", diagnostics: true, body: { Job: job } });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new NomadError(502, "Invalid Nomad validation response");
    const validation = result as Record<string, unknown>;
    const errors = validation.ValidationErrors === null ? [] : validation.ValidationErrors;
    if (typeof validation.DriverConfigValidated !== "boolean" || typeof validation.Error !== "string" || typeof validation.Warnings !== "string" || !Array.isArray(errors) || errors.some(error => typeof error !== "string")) throw new NomadError(502, "Invalid Nomad validation response");
    return { DriverConfigValidated: validation.DriverConfigValidated, ValidationErrors: errors.map(error => client.diagnostic(error)), Error: client.diagnostic(validation.Error), Warnings: client.diagnostic(validation.Warnings) };
  }, "use", true));
  router.post(`${root}/plan`, route(ctx, async (req, client, ns) => {
    const job = jobInput(objectBody(req).job, ns, client.region);
    const result = await client.request(`/v1/job/${encodeURIComponent(job.ID)}/plan`, ns, { method: "PUT", diagnostics: true, body: { Job: job, Diff: true } });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new NomadError(502, "Invalid Nomad plan response");
    const index = "JobModifyIndex" in result ? result.JobModifyIndex : undefined;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) throw new NomadError(502, "Nomad plan index exceeds JavaScript's safe integer range");
    return { ...result, ...("Warnings" in result && typeof result.Warnings === "string" ? { Warnings: client.diagnostic(result.Warnings) } : {}) };
  }, "use", true));
  router.put(`${root}/jobs`, route(ctx, async (req, client, ns) => {
    const input = objectBody(req);
    const job = jobInput(input.job, ns, client.region);
    const index = nonnegativeInteger(input.modifyIndex, "Modify index");
    const submission = input.submission === undefined ? undefined : submissionInput(input.submission);
    const result = await client.request("/v1/jobs", ns, { method: "PUT", diagnostics: true, body: { Job: job, EnforceIndex: true, JobModifyIndex: index, ...(submission === undefined ? {} : { Submission: submission }) } });
    if (result && typeof result === "object" && "Warnings" in result && typeof result.Warnings === "string") return { ...result, Warnings: client.diagnostic(result.Warnings) };
    return result;
  }, "manage", true));
  router.post(`${root}/jobs/:jobId/scale`, route(ctx, async (req, client, ns) => {
    const jobId = id(req, "jobId");
    const input = objectBody(req);
    if (typeof input.group !== "string" || !input.group.trim()) throw new NomadError(400, "Invalid task group");
    const count = nonnegativeInteger(input.count, "Count");
    const job = scoped(await client.request(`/v1/job/${jobId}`, ns), ns, req.params.jobId);
    if (!Array.isArray(job.TaskGroups) || !job.TaskGroups.some(group => group && group.Name === input.group)) throw new NomadError(400, "Task group does not belong to this job");
    return client.request(`/v1/job/${jobId}/scale`, ns, { method: "PUT", body: { Count: count, Target: { Job: req.params.jobId, Group: input.group }, Error: false, Message: "Scaled from Termix" } });
  }, "manage", true));
  router.delete(`${root}/jobs/:jobId`, route(ctx, async (req, client, ns) => {
    const jobId = id(req, "jobId");
    scoped(await client.request(`/v1/job/${jobId}`, ns), ns, req.params.jobId);
    return client.request(`/v1/job/${jobId}`, ns, { method: "DELETE", query: { purge: "false" } });
  }, "manage", true));
}
