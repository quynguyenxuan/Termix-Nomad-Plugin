import React from "react";
import { usePluginApi, type TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { Button, Input } from "@termix-ssh/plugin-sdk/ui";
import { errorMessage } from "./nomad-api";

type Query = Record<string, string | number | boolean | undefined>;
export type ResourceApi = {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  del<T = unknown>(path: string, query?: Query): Promise<T>;
  fetch(path: string, query?: Query, init?: RequestInit): Promise<Response>;
  download(path: string, query?: Query): Promise<Blob>;
  url(path: string, query?: Query): string;
};
export type PageProps = {
  hostId: string; namespace: string; canManage: boolean; canAdmin: boolean; canExec: boolean;
  selectedId?: string; onNavigate(resource: string, id?: string, namespace?: string): void;
  socketUrl?: (path: string) => Promise<{ url: string; protocols?: string[] } | null>;
};
export type Column = { key: string; title: string; render?: (row: Record<string, unknown>) => React.ReactNode };
export const RefreshContext = React.createContext(0);
export function useRefreshTick(): number { return React.useContext(RefreshContext); }
export const ResourceTransportContext = React.createContext<Pick<TermixApp, "fetch"> | null>(null);

export function useResourceApi(hostId: string, namespace: string): ResourceApi {
  const client = usePluginApi();
  const transport = React.useContext(ResourceTransportContext);
  return React.useMemo(() => {
    const base = `/hosts/${encodeURIComponent(hostId)}`;
    const params = (query?: Query) => ({ ...query, namespace });
    return {
      async get<T>(path: string, query?: Query) { return (await client.get<T>(base + path, { params: params(query) })).data; },
      async post<T>(path: string, body?: unknown) { return (await client.post<T>(base + path, body, { params: params() })).data; },
      async put<T>(path: string, body?: unknown) { return (await client.put<T>(base + path, body, { params: params() })).data; },
      async del<T>(path: string, query?: Query) { return (await client.delete<T>(base + path, { params: params(query) })).data; },
      async fetch(path: string, query?: Query, init?: RequestInit) {
        if (!transport) throw new Error("Authenticated streaming transport is unavailable");
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params(query))) if (value !== undefined) search.set(key, String(value));
        return transport.fetch(`${base}${path}?${search}`, init);
      },
      async download(path: string, query?: Query) { return (await client.get<Blob>(base + path, { params: params(query), responseType: "blob" })).data; },
      url(path: string, query?: Query) {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params(query))) if (value !== undefined) search.set(key, String(value));
        return `/plugin-api/nomad${base}${path}?${search}`;
      },
    };
  }, [client, hostId, namespace, transport]);
}

export function ErrorMessage({ error }: { error: unknown }) {
  return error ? <p role="alert" className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{typeof error === "string" ? error : errorMessage(error)}</p> : null;
}

export function ResourceBrowser({ api, endpoint, columns, onSelect, selectedId, title, query = {} }: {
  api: ResourceApi; endpoint: string; columns: Column[]; onSelect?: (row: Record<string, unknown>) => void;
  selectedId?: string; title?: string; query?: Query;
}) {
  const tick = useRefreshTick();
  const [items, setItems] = React.useState<Record<string, unknown>[]>([]);
  const [next, setNext] = React.useState("");
  const [tokens, setTokens] = React.useState<string[]>([""]);
  const [prefix, setPrefix] = React.useState(String(query.prefix ?? ""));
  const [filter, setFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [applied, setApplied] = React.useState<{ prefix?: string; filter?: string }>({});
  const [refresh, setRefresh] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>();
  const queryKey = JSON.stringify(query);
  const token = tokens[tokens.length - 1];
  React.useEffect(() => { setTokens([""]); setApplied({}); setPrefix(String(JSON.parse(queryKey).prefix ?? "")); setFilter(""); }, [endpoint, queryKey]);
  React.useEffect(() => {
    let active = true;
    setLoading(true);
    void api.get<unknown>(endpoint, { ...JSON.parse(queryKey), ...applied, next_token: token, per_page: 50 }).then((data) => {
      if (!active) return;
      const page = Array.isArray(data) ? { items: data, nextToken: "" } : data as { items?: unknown[]; nextToken?: string };
      if (!page || !Array.isArray(page.items)) throw new Error("Invalid resource list response");
      setItems(page.items as Record<string, unknown>[]); setNext(page.nextToken ?? ""); setError(undefined);
    }).catch((cause: unknown) => { if (active) setError(cause); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, endpoint, queryKey, applied, token, refresh, tick]);
  const visible = items.filter((item) => JSON.stringify(item).toLowerCase().includes(search.toLowerCase()));
  return <section className="min-w-0 space-y-3" aria-label={title ?? "Resources"}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{title}</h2><Button variant="outline" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Refresh list</Button></div>
    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); setTokens([""]); setApplied({ prefix: prefix || String(query.prefix ?? ""), filter }); }}>
      <label className="min-w-0 flex-1 text-xs">ID prefix<Input aria-label="ID prefix" className="mt-1" value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="Server-side prefix" /></label>
      <label className="min-w-0 flex-1 text-xs">Nomad filter<Input aria-label="Nomad filter" className="mt-1" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={'Status == "running"'} /></label>
      <Button type="submit" variant="outline">Apply filters</Button>
    </form>
    <Input aria-label="Search loaded page" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search this page" />
    <ErrorMessage error={error} />
    {loading && <p role="status" className="text-xs text-muted-foreground">Refreshing resources...</p>}
    <div className="max-w-full overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-sm"><thead className="bg-muted/40"><tr>{columns.map((column) => <th className="px-3 py-2 font-medium" key={column.key}>{column.title}</th>)}{onSelect && <th className="px-3 py-2"><span className="sr-only">Open resource</span></th>}</tr></thead>
        <tbody>{visible.map((row, index) => <tr key={`${String(row.Namespace ?? "")}/${String(row.ID ?? row.Name ?? row.Path ?? index)}`} className={`border-t border-border ${selectedId === (row.ID ?? row.Name ?? row.Path) ? "bg-accent/40" : ""}`}>
          {columns.map((column) => { const value = column.key.split(".").reduce<unknown>((object, key) => object && typeof object === "object" ? (object as Record<string, unknown>)[key] : undefined, row); return <td key={column.key} className="max-w-sm break-words px-3 py-2">{column.render ? column.render(row) : value == null ? "-" : typeof value === "object" ? JSON.stringify(value) : String(value)}</td>; })}
          {onSelect && <td className="px-3 py-2"><Button size="sm" variant="outline" onClick={() => onSelect(row)} aria-label={`Open ${String(row.Name ?? row.ID ?? row.Path ?? "resource")}`}>Open</Button></td>}
        </tr>)}</tbody></table>
      {!loading && !error && visible.length === 0 && <p className="p-4 text-sm text-muted-foreground">No resources match this page.</p>}
    </div>
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Button size="sm" variant="outline" disabled={tokens.length === 1 || loading} onClick={() => setTokens((value) => value.slice(0, -1))}>Previous page</Button>
      <span>Page {tokens.length} / {items.length} loaded</span>
      <Button size="sm" variant="outline" disabled={!next || next === token || loading} onClick={() => setTokens((value) => [...value, next])}>Next page</Button>
    </div>
  </section>;
}

export function JsonView({ value }: { value: unknown }) {
  return <details className="min-w-0 rounded-md border border-border p-3"><summary className="cursor-pointer text-sm">Raw Nomad response</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(value, null, 2)}</pre></details>;
}

export function JsonEditor({ initialValue, onSubmit, label = "JSON specification", disabled = false }: {
  initialValue: unknown; onSubmit(value: unknown): Promise<unknown>; label?: string; disabled?: boolean;
}) {
  const [source, setSource] = React.useState(() => JSON.stringify(initialValue, null, 2));
  const [error, setError] = React.useState<unknown>();
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  return <form className="space-y-3" onSubmit={async (event) => {
    event.preventDefault(); setError(undefined); setSaved(false); setBusy(true);
    try { await onSubmit(JSON.parse(source)); setSaved(true); } catch (cause) { setError(cause); } finally { setBusy(false); }
  }}>
    <label className="block text-sm">{label}<textarea aria-label={label} className="mt-1 min-h-64 w-full rounded-md border border-border bg-background p-3 font-mono text-xs" spellCheck={false} value={source} onChange={(event) => { setSource(event.target.value); setSaved(false); }} disabled={disabled || busy} /></label>
    <ErrorMessage error={error} />{saved && <p role="status" className="text-sm">Saved.</p>}
    <Button type="submit" disabled={disabled || busy}>{busy ? "Saving..." : "Save specification"}</Button>
  </form>;
}

export function ConfirmAction({ label, description, onConfirm, disabled = false, danger = false }: {
  label: string; description: string; onConfirm(): Promise<unknown>; disabled?: boolean; danger?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>();
  return <div className="min-w-0 space-y-2">
    <Button variant={danger ? "destructive" : "outline"} disabled={disabled || busy} onClick={() => { setOpen(true); setError(undefined); }}>{label}</Button>
    {open && <div role="dialog" aria-label={`Confirm ${label}`} className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <p className="break-words text-sm">{description}</p><ErrorMessage error={error} />
      <div className="flex flex-wrap gap-2"><Button variant={danger ? "destructive" : "default"} disabled={busy || disabled} onClick={async () => { setBusy(true); try { await onConfirm(); setOpen(false); } catch (cause) { setError(cause); } finally { setBusy(false); } }}>{busy ? "Working..." : `Confirm ${label}`}</Button><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button></div>
    </div>}
  </div>;
}

export function LiveText({ api, path, query = {}, enabled = true }: { api: ResourceApi; path: string; query?: Query; enabled?: boolean }) {
  const [running, setRunning] = React.useState(enabled);
  const [revision, setRevision] = React.useState(0);
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<unknown>();
  const [connected, setConnected] = React.useState(false);
  const queryKey = JSON.stringify(query);
  React.useEffect(() => {
    if (!running || !enabled) return;
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    setError(undefined); setText("");
    void (async () => {
      const response = await api.fetch(path, JSON.parse(queryKey), { signal: controller.signal });
      if (!response.ok) throw new Error(`Stream request failed (HTTP ${response.status})`);
      reader = response.body?.getReader();
      if (!reader) throw new Error("Streaming is unavailable");
      setConnected(true);
      const decoder = new TextDecoder();
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setText((previous) => (previous + chunk).slice(-262_144));
      }
      const final = decoder.decode();
      if (final) setText((previous) => (previous + final).slice(-262_144));
    })().catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause); }).finally(() => { if (!controller.signal.aborted) setConnected(false); });
    return () => { controller.abort(); void reader?.cancel().catch(() => {}); };
  }, [api, path, queryKey, running, enabled, revision]);
  return <section className="min-w-0 space-y-2" aria-label="Live output">
    <div className="flex flex-wrap items-center gap-2"><Button variant="outline" disabled={!enabled} onClick={() => { setConnected(false); setRunning((value) => !value); }}>{running ? "Stop stream" : "Start stream"}</Button><Button variant="outline" disabled={!enabled} onClick={() => { setRunning(true); setRevision((value) => value + 1); }}>Reconnect</Button><span className="text-xs text-muted-foreground">{connected ? "Connected" : "Disconnected"} / latest 262,144 characters; reconnect after ten minutes</span></div>
    <ErrorMessage error={error} /><pre aria-live="off" className="max-h-96 min-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/20 p-3 font-mono text-xs">{text || "No output received."}</pre>
  </section>;
}
