import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Request, Response, RequestHandler } from "express";
import { once } from "node:events";
import { hostClient, identifier, namespace, NomadClient, NomadError, scopedObject } from "./client.js";

type Permission = "use" | "manage" | "administer" | "exec";
type Handler = (req: Request, client: NomadClient, ns: string, res: Response) => Promise<unknown>;

export function route(ctx: PluginContext, handler: Handler, permission: Permission = "use", concreteNamespace = false): RequestHandler {
  return async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (!ctx.currentActor()) throw new NomadError(401, "Authentication required");
      if (!await ctx.rbac.has("use") || (permission !== "use" && !await ctx.rbac.has(permission))) throw new NomadError(403, "Nomad permission required");
      const ns = namespace(req.query.namespace, concreteNamespace);
      const client = await hostClient(ctx, req.params.hostId);
      const result = await handler(req, client, ns, res);
      if (!res.headersSent) res.json(result ?? null);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const known = error instanceof NomadError;
      res.status(known ? error.status : 502).json({ error: known ? error.message : "Unable to complete Nomad request" });
    }
  };
}

export function objectBody(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new NomadError(400, "A JSON object is required");
  return req.body;
}

export function id(req: Request, name: string): string {
  return encodeURIComponent(identifier(req.params[name], name));
}

export function scoped(value: unknown, ns: string, expectedId?: string): Record<string, unknown> {
  const object = scopedObject(value, ns);
  if (expectedId !== undefined && object.ID !== expectedId) throw new NomadError(409, "Nomad resource identity does not match the requested resource");
  return object;
}

export function listQuery(req: Request): Record<string, string> {
  const result: Record<string, string> = { per_page: "50" };
  for (const key of ["next_token", "prefix", "filter"] as const) {
    const value = req.query[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new NomadError(400, `Invalid ${key}`);
    result[key] = value;
  }
  if (req.query.per_page !== undefined) {
    const value = req.query.per_page;
    if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) throw new NomadError(400, "Page size must be between 1 and 200");
    result.per_page = String(Number(value));
  }
  if (req.query.reverse !== undefined) {
    if (req.query.reverse !== "true" && req.query.reverse !== "false") throw new NomadError(400, "Invalid reverse order");
    result.reverse = req.query.reverse;
  }
  return result;
}

export async function streamResponse(req: Request, res: Response, client: NomadClient, path: string, ns: string, query: Record<string, string> = {}): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 10 * 60_000);
  req.once("aborted", abort);
  res.once("close", abort);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const upstream = await client.open(path, ns, { query, text: true, signal: controller.signal });
    reader = upstream.body?.getReader();
    res.status(200).set({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    while (reader && !controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.byteLength; offset += 65_536) {
        if (!res.write(value.subarray(offset, offset + 65_536))) await once(res, "drain", { signal: controller.signal });
      }
    }
    if (!res.destroyed) res.end();
  } finally {
    clearTimeout(timer);
    req.removeListener("aborted", abort);
    res.removeListener("close", abort);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
  }
}
