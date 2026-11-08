import React from "react";
import { Button, Input } from "@termix-ssh/plugin-sdk/ui";
import { ConfirmAction, ErrorMessage, ResourceBrowser, useResourceApi, type PageProps } from "./ResourceUI";
import { Fields, StringItems, fieldClass, itemMap, text, useStorageDetail, type RecordValue, type StorageApi } from "./StorageCommon";

type Variable = RecordValue & { Path: string; ModifyIndex: number; Items?: Record<string, string> };
export function VariableForm({ api, initial, canManage, onSaved }: { api: StorageApi; initial?: Variable; canManage: boolean; onSaved: (value: Variable) => void }) {
  const [path, setPath] = React.useState(initial?.Path ?? "");
  const [items, setItems] = React.useState<[string, string][]>(initial ? Object.entries(initial.Items ?? {}) : [["", ""]]);
  const [index, setIndex] = React.useState(initial?.ModifyIndex ?? 0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>();
  const [saved, setSaved] = React.useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage || busy) return;
    setBusy(true); setError(undefined); setSaved(false);
    try {
      if (!path.trim() || path.startsWith("/") || path.endsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Use a relative variable path with nonempty segments.");
      if (!Number.isSafeInteger(index) || index < 0) throw new Error("Unsafe modification index. Reload the variable before editing.");
      const value = await api.put<Variable>("/variable", { Path: path, Items: itemMap(items), ModifyIndex: index });
      setIndex(value.ModifyIndex); setSaved(true); onSaved(value);
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  return <form className="space-y-3 rounded-md border p-4" onSubmit={event => void save(event)}>
    <h3 className="font-semibold">{initial ? "Edit variable" : "Create variable"}</h3>
    <p className="text-sm text-muted-foreground">Items are sensitive. Values are shown only after opening this path. Saves use compare-and-set at index {index}; conflicts never overwrite newer data.</p>
    <label className={fieldClass}>Variable path<Input aria-label="Variable path" required value={path} disabled={!!initial || busy || !canManage} onChange={event => setPath(event.target.value)} placeholder="apps/example" /></label>
    {path.startsWith("nomad/job-templates/") && <p className="text-sm">Job templates use item key <code>template</code> for HCL and <code>description</code> for readable text.</p>}
    <StringItems value={items} onChange={setItems} disabled={busy || !canManage} />
    <ErrorMessage error={error} />{saved && <p role="status">Variable saved.</p>}
    <Button type="submit" disabled={busy || !canManage}>{busy ? "Saving..." : "Save variable with CAS"}</Button>
  </form>;
}
function VariableDetail({ api, path, canManage, onDeleted }: { api: StorageApi; path: string; canManage: boolean; onDeleted: () => void }) {
  const detail = useStorageDetail<Variable>(api, "/variable", { path });
  const [editorVersion, resetEditor] = React.useReducer((n: number) => n + 1, 0);
  const [snapshot, setSnapshot] = React.useState<Variable>();
  React.useEffect(() => { if (detail.value && !snapshot) setSnapshot(detail.value); }, [detail.value, snapshot]);
  return <section className="space-y-3" aria-label="Variable detail"><h3 className="break-words font-semibold">{path}</h3><ErrorMessage error={detail.error} />{snapshot && <>
    <Fields value={snapshot} names={["Namespace", "Path", "ModifyIndex", "CreateIndex"]} />
    {detail.value && detail.value.ModifyIndex !== snapshot.ModifyIndex && <p role="status">This variable changed on the server. Your editor keeps its original revision; reload explicitly to discard edits and adopt the latest values.</p>}
    <VariableForm key={`${path}:${editorVersion}`} api={api} initial={snapshot} canManage={canManage} onSaved={value => { setSnapshot(value); detail.refresh(); }} />
    <div className="flex flex-wrap gap-2"><ConfirmAction label="Reload variable editor" description="Discard editor changes and load the latest variable values?" onConfirm={async () => { setSnapshot(await api.get<Variable>("/variable", { path })); detail.refresh(); resetEditor(); }} />
      <ConfirmAction label="Delete variable" description={`Permanently delete ${path} only if the displayed modification index ${snapshot.ModifyIndex} is unchanged?`} danger disabled={!canManage || !Number.isSafeInteger(snapshot.ModifyIndex)} onConfirm={async () => { await api.del("/variable", { path, cas: String(snapshot.ModifyIndex) }); onDeleted(); }} />
    </div>
  </>}{!snapshot && !detail.error && <p role="status">Loading variable...</p>}</section>;
}
export function VariablesContent(props: PageProps) {
  const api = useResourceApi(props.hostId, props.namespace);
  const [prefix, setPrefix] = React.useState("");
  const [draftPrefix, setDraftPrefix] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  const concrete = props.namespace !== "*";
  const browse = (value: string) => { setPrefix(value); setDraftPrefix(value); };
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">Variables</h2><Button disabled={!props.canManage || !concrete} onClick={() => { setCreating(true); props.onNavigate("variables"); }}>Create variable</Button></div>
    <p className="text-sm text-muted-foreground">Browse metadata by path prefix. Open a path explicitly to read or edit its items.</p>
    <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); browse(draftPrefix); }}><label className={`${fieldClass} grow`}>Path prefix<Input aria-label="Variable path prefix" value={draftPrefix} onChange={event => setDraftPrefix(event.target.value)} placeholder="apps/" /></label><Button type="submit">Browse path</Button></form>
    <nav aria-label="Variable path folders" className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => browse("")}>Root</Button>{prefix.split("/").filter(Boolean).map((part, index, parts) => <Button variant="outline" key={index} onClick={() => browse(`${parts.slice(0, index + 1).join("/")}/`)}>{part}/</Button>)}<Button variant="outline" onClick={() => browse("nomad/job-templates/")}>Job templates</Button></nav>
    <ResourceBrowser key={`${revision}:${prefix}`} api={api} endpoint="/variables" query={{ prefix }} title="Variable paths" selectedId={props.selectedId} columns={[{ key: "Path", title: "Path" }, { key: "Namespace", title: "Namespace" }, { key: "ModifyIndex", title: "Revision" }]} onSelect={row => { setCreating(false); props.onNavigate("variables", text(row.Path), text(row.Namespace)); }} />
    {!concrete && <p role="status" className="text-sm">Select a concrete namespace to open, create, or change variables.</p>}
    {creating && concrete && <VariableForm key={`${props.namespace}:new`} api={api} canManage={props.canManage} onSaved={value => { setCreating(false); refresh(); props.onNavigate("variables", value.Path); }} />}
    {props.selectedId && !creating && concrete && <VariableDetail key={`${props.hostId}:${props.namespace}:${props.selectedId}`} api={api} path={props.selectedId} canManage={props.canManage} onDeleted={() => { refresh(); props.onNavigate("variables"); }} />}
  </div>;
}
