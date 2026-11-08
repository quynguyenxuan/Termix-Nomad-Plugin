import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import WebSocket from "ws";

type RequestOptions = { method?: string; body?: unknown; query?: Record<string, string>; text?: boolean; signal?: AbortSignal; csiSecrets?: Record<string, string>; diagnostics?: boolean };

export class NomadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type Job = Record<string, unknown> & { ID: string; Namespace: string };
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC = 16 * 1024;
export const LOG_BYTES = 64 * 1024;

export function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value) || value === "." || value === "..") {
    throw new NomadError(400, `Invalid ${label}`);
  }
  return value;
}

export function namespace(value: unknown, mutation = false): string {
  const ns = value === undefined ? "default" : identifier(value, "namespace");
  if (mutation && ns.includes("*")) throw new NomadError(400, "A concrete namespace is required");
  return ns;
}

export function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new NomadError(400, `${label} must be a nonnegative safe integer`);
  }
  return value;
}

export function scopedObject(value: unknown, ns: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NomadError(502, "Invalid Nomad response");
  const object = value as Record<string, unknown>;
  if (ns !== "*" && object.Namespace !== ns) throw new NomadError(409, "Nomad namespace does not match the selected namespace");
  return object;
}

export function jobInput(value: unknown, ns: string, region: string): Job {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NomadError(400, "A job object is required");
  const job = value as Record<string, unknown>;
  const id = identifier(job.ID, "job ID");
  if (job.Namespace !== undefined && job.Namespace !== null && job.Namespace !== ns) throw new NomadError(400, "Job namespace does not match the selected namespace");
  if (job.Region !== undefined && job.Region !== null && job.Region !== region) throw new NomadError(400, "Job region does not match the configured region");
  return { ...job, ID: id, Namespace: ns, Region: region };
}

export class NomadClient {
  constructor(private ctx: Pick<PluginContext, "fetch">, private address: URL, private token: string, public region: string) {}

  diagnostic(value: string): string {
    const redacted = this.token ? value.split(this.token).join("[redacted]") : value;
    if (/<\s*[!?/a-z]/i.test(redacted)) return "Nomad returned an invalid diagnostic";
    const plain = redacted.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
    if (Buffer.byteLength(plain) > MAX_DIAGNOSTIC) return "Nomad diagnostic exceeds the size limit";
    return plain;
  }

  private async errorDiagnostic(response: Response, signal?: AbortSignal): Promise<string> {
    if (!/^text\/plain\b/i.test(response.headers.get("Content-Type") ?? "")) {
      void response.body?.cancel().catch(() => {});
      return "";
    }
    const reader = response.body?.getReader();
    if (!reader) return "";
    const { promise: stopped, reject } = Promise.withResolvers<never>();
    const abort = () => reject(new Error("Diagnostic read stopped"));
    const timer = setTimeout(abort, 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await Promise.race([reader.read(), stopped]);
        if (done) break;
        size += value.byteLength;
        // Never expose a truncated body that could cut an ACL token in half.
        if (size > MAX_DIAGNOSTIC) return "";
        chunks.push(value);
      }
      return this.diagnostic(Buffer.concat(chunks, size).toString("utf8"));
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void reader.cancel().catch(() => {});
    }
  }

  private url(path: string, ns: string, query: Record<string, string> = {}): URL {
    if (!path.startsWith("/v1/") || path.includes("?") || path.includes("#")) throw new NomadError(400, "Invalid Nomad API path");
    const url = new URL(this.address.href);
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
    url.searchParams.set("namespace", ns);
    url.searchParams.set("region", this.region);
    for (const [key, value] of Object.entries(query)) {
      if (key === "namespace" || key === "region") throw new NomadError(400, "Cannot override the selected scope");
      url.searchParams.set(key, value);
    }
    return url;
  }

  async open(path: string, ns: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.url(path, ns, options.query);
    const secrets = Object.entries(options.csiSecrets ?? {});
    if (secrets.length > 128 || secrets.some(([key, value]) => !key || /[\r\n,=]/.test(key) || typeof value !== "string" || /[\r\n,]/.test(value))) throw new NomadError(400, "Invalid CSI secrets");
    const csiHeader = secrets.map(([key, value]) => `${key}=${value}`).join(",");
    if (csiHeader.length > 16_384) throw new NomadError(400, "CSI secrets exceed the size limit");
    try {
      const response = await this.ctx.fetch(url.href, {
        method: options.method ?? "GET", redirect: "error", timeoutMs: 15_000,
        signal: options.signal, allowPrivateHosts: [url.hostname],
        headers: { Accept: options.text ? "text/plain" : "application/json", ...(this.token ? { "X-Nomad-Token": this.token } : {}), ...(csiHeader ? { "X-Nomad-CSI-Secrets": csiHeader } : {}), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (!response.ok) {
        const detail = options.diagnostics ? await this.errorDiagnostic(response, options.signal) : "";
        if (!options.diagnostics) void response.body?.cancel().catch(() => {});
        throw new NomadError([400, 401, 403, 404, 409, 429].includes(response.status) ? response.status : 502, `Nomad request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
      }
      return response;
    } catch (error) {
      if (error instanceof NomadError) throw error;
      throw new NomadError(options.signal?.aborted ? 504 : 502, options.signal?.aborted ? "Nomad request timed out" : "Unable to contact Nomad");
    }
  }

  private async read(path: string, ns: string, options: RequestOptions): Promise<{ value: unknown; nextToken: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.open(path, ns, { ...options, signal: controller.signal });
      reader = response.body?.getReader();
      const limit = options.text ? LOG_BYTES : MAX_RESPONSE;
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = limit - size;
        if (value.byteLength > remaining && !options.text) throw new NomadError(502, "Nomad response exceeds the size limit");
        const chunk = value.subarray(0, remaining);
        chunks.push(chunk);
        size += chunk.byteLength;
        if (options.text && size === limit) break;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder().decode(bytes);
      let value: unknown = null;
      if (options.text) value = text;
      else if (text.trim()) {
        try { value = JSON.parse(text); } catch { throw new NomadError(502, "Nomad returned invalid JSON"); }
      }
      return { value, nextToken: response.headers.get("X-Nomad-NextToken") ?? "" };
    } catch (error) {
      if (error instanceof NomadError) throw error;
      throw new NomadError(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? "Nomad request timed out" : "Unable to contact Nomad");
    } finally {
      clearTimeout(timer);
      if (reader) void reader.cancel().catch(() => {});
      controller.abort();
    }
  }

  async request(path: string, ns: string, options: RequestOptions = {}): Promise<unknown> {
    return (await this.read(path, ns, options)).value;
  }

  async page(path: string, ns: string, query: Record<string, string> = {}): Promise<{ items: unknown[]; nextToken: string }> {
    const { value, nextToken } = await this.read(path, ns, { query });
    if (value !== null && !Array.isArray(value)) throw new NomadError(502, "Nomad returned an invalid resource list");
    return { items: Array.isArray(value) ? value : [], nextToken };
  }

  async socket(ctx: PluginContext, path: string, ns: string, query: Record<string, string> = {}): Promise<WebSocket> {
    await ctx.capabilities.require("network:outbound");
    const url = this.url(path, ns, query);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let addresses;
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new NomadError(502, "Unable to resolve Nomad"); }
    const target = addresses.find((entry) => isIP(entry.address) === 4) ?? addresses[0];
    if (!target) throw new NomadError(502, "Unable to resolve Nomad");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
    const socket = new WebSocket(url, {
      headers: this.token ? { "X-Nomad-Token": this.token } : {},
      followRedirects: false, rejectUnauthorized: true, handshakeTimeout: 15_000,
      maxPayload: 1024 * 1024, perMessageDeflate: false,
      family: target.family,
      lookup: (_name, _options, callback) => callback(null, target.address, target.family),
    });
    const failed = () => { socket.terminate(); reject(new NomadError(502, "Unable to establish Nomad exec session")); };
    socket.once("error", failed);
    socket.once("unexpected-response", (_request, response) => { response.destroy(); failed(); });
    socket.once("open", () => { socket.removeListener("error", failed); resolve(socket); });
    return promise;
  }
}

export async function hostClient(ctx: PluginContext, rawHostId: unknown): Promise<NomadClient> {
  if (!ctx.currentActor()) throw new NomadError(401, "Authentication required");
  if (typeof rawHostId !== "string" || !/^[1-9]\d*$/.test(rawHostId) || !Number.isSafeInteger(Number(rawHostId))) throw new NomadError(400, "Invalid host ID");
  const hostId = Number(rawHostId);
  const host = await ctx.hosts.get(hostId);
  if (!host) throw new NomadError(404, "Host not found or access denied");
  const access = await ctx.hosts.checkAccess(hostId, "connect");
  if (!access.hasAccess) throw new NomadError(403, "Host connection access required");
  if (await ctx.settings.getHost(hostId, "enableNomad") !== true) throw new NomadError(403, "Nomad is not enabled for this host");
  const configured = await ctx.settings.getHost<unknown>(hostId, "address");
  if (configured !== undefined && configured !== null && typeof configured !== "string") throw new NomadError(400, "Invalid Nomad address setting");
  const ip = host.ip.includes(":") && !host.ip.startsWith("[") ? `[${host.ip}]` : host.ip;
  let address: URL;
  try { address = new URL(typeof configured === "string" && configured.trim() ? configured.trim() : `http://${ip}:4646`); } catch { throw new NomadError(400, "Invalid Nomad address"); }
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new NomadError(400, "Invalid Nomad address");
  const region = await ctx.settings.getHost<unknown>(hostId, "region");
  if (region !== undefined && region !== null && typeof region !== "string") throw new NomadError(400, "Invalid Nomad region setting");
  const token = await ctx.settings.getHost<unknown>(hostId, "token");
  if (token !== undefined && token !== null && typeof token !== "string") throw new NomadError(400, "Invalid Nomad token setting");
  return new NomadClient(ctx, address, typeof token === "string" ? token : "", typeof region === "string" && region.trim() ? identifier(region, "region") : "global");
}
