import type { Request, Router } from "express";
import { once } from "node:events";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { identifier, NomadClient, NomadError, nonnegativeInteger } from "./client.js";
import { route, objectBody, listQuery, id, scoped, streamResponse } from "./route-utils.js";
export { registerAllocationSockets } from "./allocation-sockets.js";

export async function allocationIdentity(client: NomadClient, ns: string, allocationId: string): Promise<Record<string, unknown>> {
  return scoped(await client.request(`/v1/allocation/${encodeURIComponent(allocationId)}`, ns), ns, allocationId);
}
export function allocationTask(allocation: Record<string, unknown>, value: unknown): string {
  const task = identifier(value, "task");
  if (!allocation.TaskStates || typeof allocation.TaskStates !== "object" || !Object.hasOwn(allocation.TaskStates, task)) throw new NomadError(400, "Task does not belong to this allocation");
  return task;
}
export function allocationPath(value: unknown): string {
  if (value === undefined || value === "" || value === "/") return ".";
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value) || value.startsWith("/") || value.split("/").includes("..")) throw new NomadError(400, "Invalid allocation file path");
  return value;
}
function integerQuery(value: unknown, fallback: number, max: number): string {
  if (value === undefined) return String(fallback);
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new NomadError(400, "Invalid file offset or limit");
  const n = nonnegativeInteger(Number(value), "File offset or limit");
  if (n > max) throw new NomadError(400, "File offset or limit exceeds the allowed range");
  return String(n);
}

export function registerAllocationRoutes(router: Router, ctx: PluginContext): void {
  const root = "/hosts/:hostId/allocations";
  router.get(root, route(ctx, async (req, client, ns) => {
    const page = await client.page("/v1/allocations", ns, listQuery(req));
    return { ...page, items: page.items.map(value => scoped(value, ns)) };
  }));
  router.get(`${root}/:allocationId`, route(ctx, async (req, client, ns) => allocationIdentity(client, ns, identifier(req.params.allocationId, "allocation ID"))));
  router.get(`${root}/:allocationId/stats`, route(ctx, async (req, client, ns) => {
    await allocationIdentity(client, ns, identifier(req.params.allocationId, "allocation ID"));
    return client.request(`/v1/client/allocation/${id(req, "allocationId")}/stats`, ns);
  }));
  router.post(`${root}/:allocationId/restart`, route(ctx, async (req, client, ns) => {
    const allocation = await allocationIdentity(client, ns, identifier(req.params.allocationId, "allocation ID"));
    const body = objectBody(req);
    if (body.allTasks !== undefined && typeof body.allTasks !== "boolean") throw new NomadError(400, "allTasks must be a boolean");
    if (body.allTasks === true && body.task !== undefined) throw new NomadError(400, "Choose one task or all tasks");
    const task = body.allTasks === true ? "" : allocationTask(allocation, body.task);
    await client.request(`/v1/client/allocation/${id(req, "allocationId")}/restart`, ns, { method: "PUT", body: { TaskName: task, AllTasks: body.allTasks === true } });
    return { submitted: true };
  }, "manage", true));
  router.post(`${root}/:allocationId/stop`, route(ctx, async (req, client, ns) => {
    await allocationIdentity(client, ns, identifier(req.params.allocationId, "allocation ID"));
    return client.request(`/v1/allocation/${id(req, "allocationId")}/stop`, ns, { method: "PUT" });
  }, "manage", true));
  const logs = async (req: Request, client: NomadClient, ns: string) => {
    const allocation = await allocationIdentity(client, ns, identifier(req.params.allocationId, "allocation ID"));
    const task = allocationTask(allocation, req.query.task);
    if (req.query.type !== "stdout" && req.query.type !== "stderr") throw new NomadError(400, "Log type must be stdout or stderr");
    return { task, type: req.query.type, plain: "true", origin: "end", offset: "65536" };
  };
  router.get(`${root}/:allocationId/logs`, route(ctx, async (req, client, ns) => ({ text: await client.request(`/v1/client/fs/logs/${id(req, "allocationId")}`, ns, { text: true, query: { ...await logs(req, client, ns), follow: "false" } }) })));
  router.get(`${root}/:allocationId/logs/stream`, route(ctx, async (req, client, ns, res) => {
    const query = await logs(req, client, ns);
    await streamResponse(req, res, client, `/v1/client/fs/logs/${id(req, "allocationId")}`, ns, { ...query, follow: "true" });
  }));
  for (const operation of ["ls", "stat", "read"] as const) {
    router.get(`${root}/:allocationId/fs/${operation}`, route(ctx, async (req, client, ns) => {
      await allocationIdentity(client, ns, identifier(req.params.allocationId, "allocation ID"));
      const query: Record<string, string> = { path: allocationPath(req.query.path) };
      if (operation === "read") {
        query.offset = integerQuery(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
        query.limit = integerQuery(req.query.limit, 65536, 65536);
        if (query.limit === "0") throw new NomadError(400, "Read limit must be positive");
        return { text: await client.request(`/v1/client/fs/readat/${id(req, "allocationId")}`, ns, { query, text: true }) };
      }
      const value = await client.request(`/v1/client/fs/${operation}/${id(req, "allocationId")}`, ns, { query });
      return operation === "ls" && value === null ? [] : value;
    }));
  }
  router.get(`${root}/:allocationId/fs/download`, route(ctx, async (req, client, ns, res) => {
    await allocationIdentity(client, ns, identifier(req.params.allocationId, "allocation ID"));
    const path = allocationPath(req.query.path);
    const stat = await client.request(`/v1/client/fs/stat/${id(req, "allocationId")}`, ns, { query: { path } }) as { IsDir?: boolean; Size?: number };
    if (!stat || typeof stat !== "object" || Array.isArray(stat)) throw new NomadError(502, "Invalid Nomad file metadata");
    const max = 64 * 1024 * 1024;
    if (stat.IsDir || typeof stat.Size !== "number" || !Number.isSafeInteger(stat.Size) || stat.Size < 0 || stat.Size > max) throw new NomadError(400, "Download requires a file of at most 64 MiB");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once("close", cancel);
    const timer = setTimeout(cancel, 300_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await client.open(`/v1/client/fs/cat/${id(req, "allocationId")}`, ns, { query: { path }, signal: controller.signal });
      reader = response.body?.getReader();
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", `attachment; filename="${(path.split("/").pop() || "download").replace(/[^a-zA-Z0-9._-]/g, "_")}"`);
      let size = 0;
      while (reader && !controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max || value.byteLength > 1024 * 1024) throw new NomadError(502, "Download exceeds the size limit");
        if (!res.write(value)) await once(res, "drain", { signal: controller.signal });
      }
      res.end();
    } catch (error) {
      if (res.headersSent) res.destroy();
      else throw error;
    } finally {
      clearTimeout(timer);
      res.off("close", cancel);
      controller.abort();
      await reader?.cancel().catch(() => {});
    }
  }));
}
