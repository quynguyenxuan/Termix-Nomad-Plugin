import type { IncomingMessage } from "node:http";
import type { PluginContext, PluginWebSocketConnection } from "@termix-ssh/plugin-sdk/backend";
import WebSocket, { type RawData } from "ws";
import { hostClient, identifier, namespace, NomadError } from "./client.js";
import { allocationIdentity, allocationTask } from "./allocation-routes.js";

const FRAME_LIMIT = 256 * 1024;
const QUEUE_LIMIT = 1024 * 1024;
export function execCommand(value: unknown): string[] {
  if (typeof value !== "string" || Buffer.byteLength(value) > 8192) throw new NomadError(400, "Command must be a JSON argument array of at most 8 KiB");
  let command: unknown;
  try { command = JSON.parse(value); } catch { throw new NomadError(400, "Command must be a JSON argument array"); }
  if (!Array.isArray(command) || command.length < 1 || command.length > 64 || command.some(part => typeof part !== "string" || part.length > 4096 || part.includes("\0")) || !command[0]) throw new NomadError(400, "Invalid command argument array");
  return command;
}
export function execInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid terminal input");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1) throw new Error("Invalid terminal input");
  if (input.stdin && typeof input.stdin === "object" && !Array.isArray(input.stdin)) {
    const stdin = input.stdin as Record<string, unknown>;
    if (Object.keys(stdin).length !== 1) throw new Error("Invalid terminal input");
    if (stdin.close === true) return { stdin: { close: true } };
    if (typeof stdin.data === "string" && stdin.data.length <= 49152 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(stdin.data)) return { stdin: { data: stdin.data } };
  }
  if (input.tty_size && typeof input.tty_size === "object" && !Array.isArray(input.tty_size)) {
    const size = input.tty_size as Record<string, unknown>;
    if (Object.keys(size).length === 2 && [size.height, size.width].every(n => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 1000)) return { tty_size: { height: size.height, width: size.width } };
  }
  throw new Error("Invalid terminal input");
}

export function registerAllocationSockets(ctx: PluginContext): void {
  ctx.ws.route("/allocations/exec", async (connection: PluginWebSocketConnection) => {
    const browser = connection.socket as WebSocket;
    let upstream: WebSocket | undefined;
    let finished = false;
    let starting = true;
    let checksPending = false;
    let rateBytes = 0;
    let heartbeat: NodeJS.Timeout | undefined;
    let expiry: NodeJS.Timeout | undefined;
    const close = (code = 1000, reason = "Terminal closed") => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      clearTimeout(expiry);
      if (upstream) { upstream.close(); const force = setTimeout(() => upstream?.terminate(), 1000); force.unref(); }
      if (browser.readyState === WebSocket.OPEN) browser.close(code, reason);
      const force = setTimeout(() => { if (browser.readyState !== WebSocket.CLOSED) browser.terminate(); }, 1000);
      force.unref();
    };
    browser.once("close", () => close());
    browser.once("error", () => close(1011, "Terminal transport failed"));
    // Refuse data during authorization, rather than buffering unauthenticated commands.
    browser.on("message", (bytes: RawData, binary: boolean) => {
      if (finished) return;
      if (starting || !upstream || upstream.readyState !== WebSocket.OPEN) { close(1008, "Terminal is not ready"); return; }
      if (!connection.isDataUnlocked()) { close(1008, "Session expired"); return; }
      const size = Array.isArray(bytes) ? bytes.reduce((n, part) => n + part.length, 0) : bytes.byteLength;
      rateBytes += size;
      if (binary || size > 65536 || rateBytes > FRAME_LIMIT || upstream.bufferedAmount > QUEUE_LIMIT) { close(1009, "Terminal input limit exceeded"); return; }
      try {
        const payload = JSON.stringify(execInput(JSON.parse(bytes.toString())));
        upstream.send(payload, error => { if (error) close(1011, "Terminal transport failed"); });
      } catch { close(1008, "Invalid terminal input"); }
    });
    try {
      if (!connection.userId || !connection.isDataUnlocked() || !ctx.currentActor()) throw new NomadError(401, "Authentication required");
      if (!await ctx.rbac.hasFor(connection.userId, "use") || !await ctx.rbac.hasFor(connection.userId, "exec")) throw new NomadError(403, "Terminal permission required");
      const request = connection.request as IncomingMessage;
      const query = new URL(request.url || "", "http://plugin.invalid").searchParams;
      const allowed: Record<string, true> = { hostId: true, namespace: true, allocationId: true, task: true, command: true };
      for (const key of query.keys()) if (!Object.hasOwn(allowed, key) || query.getAll(key).length !== 1) throw new NomadError(400, "Invalid terminal query");
      const hostId = query.get("hostId");
      const ns = namespace(query.get("namespace") ?? undefined, true);
      const allocationId = identifier(query.get("allocationId"), "allocation ID");
      const command = execCommand(query.get("command"));
      const client = await hostClient(ctx, hostId);
      const allocation = await allocationIdentity(client, ns, allocationId);
      const task = allocationTask(allocation, query.get("task"));
      if (finished || !connection.isDataUnlocked()) { close(1008, "Session expired"); return; }
      upstream = await client.socket(ctx, `/v1/client/allocation/${encodeURIComponent(allocationId)}/exec`, ns, { task, command: JSON.stringify(command), tty: "true" });
      if (finished || !connection.isDataUnlocked()) { upstream.terminate(); close(1008, "Session expired"); return; }
      starting = false;
      upstream.on("message", (bytes: RawData, binary: boolean) => {
        if (finished) return;
        const size = Array.isArray(bytes) ? bytes.reduce((n, part) => n + part.length, 0) : bytes.byteLength;
        if (binary || size > FRAME_LIMIT || browser.bufferedAmount > QUEUE_LIMIT || !connection.isDataUnlocked()) { close(1009, "Terminal output limit or session expired"); return; }
        try {
          const frame = JSON.parse(bytes.toString()) as Record<string, unknown>;
          const output: Record<string, unknown> = {};
          for (const stream of ["stdout", "stderr"] as const) {
            const io = frame[stream] as { data?: unknown; close?: unknown } | undefined;
            if (io) {
              if (io.data !== undefined && (typeof io.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(io.data))) throw new Error("Invalid output");
              output[stream] = { ...(io.data ? { data: io.data } : {}), ...(io.close === true ? { close: true } : {}) };
            }
          }
          if (frame.exited === true) {
            const result = frame.result as { exit_code?: unknown } | undefined;
            const exitCode = result?.exit_code === undefined ? 0 : result.exit_code;
            if (!result || typeof result !== "object" || Array.isArray(result) || !Number.isInteger(exitCode)) throw new Error("Invalid exit status");
            output.exited = true;
            output.result = { exit_code: exitCode };
          }
          upstream!.pause();
          browser.send(JSON.stringify(output), error => {
            if (error) close(1011, "Terminal transport failed");
            else if (output.exited) close();
            else if (!finished) upstream!.resume();
          });
        } catch { close(1011, "Invalid Nomad terminal response"); }
      });
      upstream.once("close", () => close(1000, "Nomad terminal closed"));
      upstream.once("error", () => close(1011, "Nomad terminal failed"));
      browser.send(JSON.stringify({ ready: true }));
      let seconds = 0;
      heartbeat = setInterval(() => {
        rateBytes = 0;
        if (!connection.isDataUnlocked()) { close(1008, "Session expired"); return; }
        if (++seconds % 10 || checksPending || finished) return;
        checksPending = true;
        void Promise.all([ctx.rbac.hasFor(connection.userId, "use"), ctx.rbac.hasFor(connection.userId, "exec"), ctx.hosts.checkAccess(Number(hostId), "connect"), ctx.hosts.get(Number(hostId)), ctx.settings.getHost(Number(hostId), "enableNomad")]).then(([use, exec, access, host, enabled]) => {
          if (!use || !exec || !access.hasAccess || !host || enabled !== true) close(1008, "Terminal access revoked");
          else if (!finished && upstream?.readyState === WebSocket.OPEN) upstream.send("{}", error => { if (error) close(1011, "Terminal transport failed"); });
        }).catch(() => close(1008, "Unable to revalidate terminal access")).finally(() => { checksPending = false; });
      }, 1000);
      expiry = setTimeout(() => close(1000, "Terminal session reached its 30 minute limit"), 30 * 60_000);
    } catch (error) {
      close(error instanceof NomadError && error.status < 500 ? 1008 : 1011, error instanceof NomadError && error.status < 500 ? error.message.slice(0, 100) : "Unable to open Nomad terminal");
    }
  });
}
