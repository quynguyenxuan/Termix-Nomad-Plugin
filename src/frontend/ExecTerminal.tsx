import React from "react";
import { Button, Input } from "@termix-ssh/plugin-sdk/ui";
import "@xterm/xterm/css/xterm.css";

export interface SocketTarget { url: string; protocols?: string[] }
export interface ExecTerminalProps {
  hostId: string;
  namespace: string;
  allocationId: string;
  task: string;
  socketUrl?: (path: string) => Promise<SocketTarget | null>;
}
export function ExecTerminal({ hostId, namespace, allocationId, task, socketUrl }: ExecTerminalProps) {
  const element = React.useRef<HTMLDivElement>(null);
  const socket = React.useRef<WebSocket | null>(null);
  const [command, setCommand] = React.useState('["/bin/sh"]');
  const [session, setSession] = React.useState<{ command: string[] } | null>(null);
  const [status, setStatus] = React.useState("Disconnected");
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    if (!session || !socketUrl) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    let ws: WebSocket | undefined;
    setStatus("Connecting");
    setError("");
    void (async () => {
      const [{ Terminal }, { FitAddon }, target] = await Promise.all([
        import("@xterm/xterm"), import("@xterm/addon-fit"),
        socketUrl(`/allocations/exec?${new URLSearchParams({ hostId, namespace, allocationId, task, command: JSON.stringify(session.command) })}`),
      ]);
      if (cancelled) return;
      if (!target || !element.current) throw new Error("Authenticated terminal transport is unavailable");
      const terminal = new Terminal({ cursorBlink: true, convertEol: false, scrollback: 3000, fontSize: 13, theme: { background: "#111820", foreground: "#e2e8f0" } });
      dispose = () => terminal.dispose();
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element.current);
      fit.fit();
      let ready = false;
      let pending = 0;
      ws = new WebSocket(target.url, target.protocols);
      socket.current = ws;
      const send = (value: unknown) => {
        if (!ready || ws?.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 1024 * 1024) { setError("Terminal input is congested; disconnected"); ws.close(); return; }
        ws.send(JSON.stringify(value));
      };
      const resize = () => {
        if (cancelled) return;
        fit.fit();
        send({ tty_size: { height: terminal.rows, width: terminal.cols } });
      };
      const observer = new ResizeObserver(resize);
      dispose = () => { observer.disconnect(); terminal.dispose(); };
      observer.observe(element.current);
      const input = terminal.onData(data => {
        const bytes = new TextEncoder().encode(data);
        for (let i = 0; i < bytes.length; i += 16384) {
          let binary = "";
          for (const byte of bytes.subarray(i, i + 16384)) binary += String.fromCharCode(byte);
          send({ stdin: { data: btoa(binary) } });
        }
      });
      ws.onmessage = event => {
        if (cancelled) return;
        try {
          if (typeof event.data !== "string" || event.data.length > 256 * 1024) throw new Error("Terminal frame exceeds the size limit");
          const frame = JSON.parse(event.data) as { ready?: boolean; stdout?: { data?: string }; stderr?: { data?: string }; exited?: boolean; result?: { exit_code: number } };
          if (frame.ready) { ready = true; setStatus("Connected"); resize(); terminal.focus(); }
          for (const io of [frame.stdout, frame.stderr]) {
            if (!io?.data) continue;
            const bytes = Uint8Array.from(atob(io.data), char => char.charCodeAt(0));
            pending += bytes.byteLength;
            if (pending > 1024 * 1024) throw new Error("Terminal output is congested; disconnected");
            terminal.write(bytes, () => { pending -= bytes.byteLength; });
          }
          if (frame.exited) { ready = false; setStatus(`Exited (${frame.result?.exit_code ?? "unknown"})`); }
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid terminal response"); ws?.close(); }
      };
      ws.onerror = () => { if (!cancelled) setError("Unable to connect to the authenticated terminal"); };
      ws.onclose = event => {
        ready = false;
        if (!cancelled) setStatus(current => current.startsWith("Exited") ? current : event.reason || "Disconnected");
      };
      dispose = () => { observer.disconnect(); input.dispose(); terminal.dispose(); };
    })().catch(cause => { ws?.close(); dispose?.(); dispose = undefined; if (!cancelled) { setError(cause instanceof Error ? cause.message : "Unable to open terminal"); setStatus("Disconnected"); } });
    return () => { cancelled = true; ws?.close(); socket.current = null; dispose?.(); };
  }, [session, socketUrl, hostId, namespace, allocationId, task]);
  function connect() {
    try {
      const parsed: unknown = JSON.parse(command);
      if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 64 || parsed.some(part => typeof part !== "string" || part.length > 4096 || part.includes("\0")) || !parsed[0] || new TextEncoder().encode(command).length > 8192) throw new Error("Command must be a nonempty JSON array of arguments (at most 8 KiB)");
      setSession({ command: parsed });
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid command"); }
  }
  return <section aria-label="Interactive allocation terminal" className="space-y-3">
    <h3 className="font-medium">Exec: {task}</h3>
    <p className="text-sm text-muted-foreground">Runs as the task's configured user. Commands are argument arrays, not a shell expression. Sessions expire after 30 minutes.</p>
    <label className="block text-sm">Command arguments (JSON)<Input aria-label="Exec command arguments" value={command} onChange={event => setCommand(event.target.value)} /></label>
    <div className="flex flex-wrap items-center gap-2"><Button disabled={!socketUrl || !task || namespace === "*"} onClick={connect}>{session ? "Reconnect terminal" : "Connect terminal"}</Button><Button variant="outline" disabled={!session} onClick={() => { socket.current?.close(1000, "Disconnected by user"); setSession(null); setStatus("Disconnected"); }}>Disconnect terminal</Button><span role="status" className="text-sm">{status}</span></div>
    {!socketUrl && <p role="alert">Authenticated terminal transport is unavailable.</p>}
    {namespace === "*" && <p>Select a concrete namespace to execute a command.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div ref={element} className="min-w-0 overflow-hidden rounded-md" style={{ height: 360, background: "#111820", padding: 8 }} />
  </section>;
}
