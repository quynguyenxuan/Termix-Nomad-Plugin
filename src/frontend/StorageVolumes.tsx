import React from "react";
import { Button, Input } from "@termix-ssh/plugin-sdk/ui";
import { ConfirmAction, ErrorMessage, JsonView, ResourceBrowser, useResourceApi, type PageProps } from "./ResourceUI";
import { AdvancedJson, Fields, Links, StorageTable, fieldClass, jsonObject, records, selectClass, text, useStorageDetail, type RecordValue, type StorageApi } from "./StorageCommon";

type VolumeKind = "csi" | "host";
function capacity(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Capacity must be a nonnegative safe integer in bytes.");
  return Number(value);
}
export function VolumeForm({ api, kind, canManage, onSaved }: { api: StorageApi; kind: VolumeKind; canManage: boolean; onSaved: () => void }) {
  const [operation, setOperation] = React.useState("create");
  const [fields, setFields] = React.useState({ ID: "", Name: "", PluginID: "", ExternalID: "", NodeID: "", NodePool: "", HostPath: "", min: "0", max: "0", attachment: "file-system", access: "single-node-writer" });
  const [advanced, setAdvanced] = React.useState("{}");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>();
  const [result, setResult] = React.useState<unknown>();
  const update = (field: keyof typeof fields, value: string) => setFields(current => ({ ...current, [field]: value }));
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!canManage || busy) return;
    setBusy(true); setError(undefined); setResult(undefined);
    try {
      const spec = jsonObject(advanced);
      const min = capacity(fields.min); const max = capacity(fields.max);
      if (max && max < min) throw new Error("Maximum capacity must be zero (unbounded) or at least the minimum.");
      const Volume: RecordValue = { ...spec, Name: fields.Name, PluginID: fields.PluginID, RequestedCapabilities: [{ AttachmentMode: fields.attachment, AccessMode: fields.access }] };
      if (kind === "csi") Object.assign(Volume, { ID: fields.ID, ExternalID: fields.ExternalID, RequestedCapacityMin: min, RequestedCapacityMax: max });
      else Object.assign(Volume, { NodeID: fields.NodeID, NodePool: fields.NodePool, RequestedCapacityMinBytes: min, RequestedCapacityMaxBytes: max, ...(fields.ID ? { ID: fields.ID } : {}), ...(operation === "register" ? { HostPath: fields.HostPath } : {}) });
      const response = await api.post(`/${kind}-volumes/${operation}`, { Volume });
      setResult(response ?? { message: "Volume operation completed." }); onSaved();
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  const input = (label: string, field: keyof typeof fields, required = false) => <label className={fieldClass}>{label}<Input aria-label={label} required={required} value={fields[field]} disabled={busy || !canManage} onChange={event => update(field, event.target.value)} /></label>;
  return <form onSubmit={event => void submit(event)} className="space-y-3 rounded-md border p-4"><h3 className="font-semibold">{kind === "csi" ? "CSI" : "Dynamic host"} volume specification</h3>
    <label className={fieldClass}>Volume operation<select aria-label="Volume operation" className={selectClass} value={operation} disabled={busy} onChange={event => setOperation(event.target.value)}><option value="create">Create storage and register</option><option value="register">Register existing storage</option></select></label>
    <p className="text-sm text-muted-foreground">{kind === "csi" ? "CSI create provisions provider storage; register adopts existing provider storage. Plugin capabilities and server ACLs determine support." : "Dynamic host volumes are created on a Nomad client. Register adopts an existing client path; it does not copy files."}</p>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{input("Volume name", "Name", true)}{input(kind === "csi" ? "Volume ID" : "Volume ID (optional)", "ID", kind === "csi")}{input("Plugin ID", "PluginID", kind === "csi")}
      {kind === "csi" ? input("External provider ID", "ExternalID", operation === "register") : <>{input("Node ID", "NodeID", operation === "register")}{input("Node pool", "NodePool")}{operation === "register" && input("Host path", "HostPath", true)}</>}
      {input("Minimum capacity (bytes)", "min")}{input("Maximum capacity (bytes, 0 unbounded)", "max")}
      <label className={fieldClass}>Attachment mode<select className={selectClass} aria-label="Attachment mode" value={fields.attachment} onChange={event => update("attachment", event.target.value)}><option value="file-system">File system</option><option value="block-device">Block device</option></select></label>
      <label className={fieldClass}>Access mode<select className={selectClass} aria-label="Access mode" value={fields.access} onChange={event => update("access", event.target.value)}>{["single-node-writer", "single-node-reader-only", ...(kind === "csi" ? ["multi-node-reader-only", "multi-node-single-writer", "multi-node-multi-writer"] : ["single-node-single-writer", "single-node-multi-writer"])].map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></label>
    </div>
    <p className="text-xs text-muted-foreground">Advanced fields accept Nomad API JSON: Parameters, Secrets, Constraints, RequestedTopologies, MountOptions, CloneID or SnapshotID. Form fields take precedence.</p>
    <AdvancedJson label="Advanced volume fields (JSON)" value={advanced} onChange={setAdvanced} /><ErrorMessage error={error} />
    <Button type="submit" disabled={busy || !canManage}>{busy ? "Submitting..." : `${operation === "create" ? "Create" : "Register"} volume`}</Button>
    {result !== undefined && <section aria-label="Volume operation result"><p role="status">Volume operation completed. Review any server warnings.</p><JsonView value={result} /></section>}
  </form>;
}
function Expansion({ api, volume, disabled, onChanged }: { api: StorageApi; volume: RecordValue; disabled: boolean; onChanged: () => void }) {
  const [min, setMin] = React.useState(text(volume.Capacity ?? 0));
  const [max, setMax] = React.useState("0");
  const [advanced, setAdvanced] = React.useState("{}");
  return <section aria-label="Expand CSI volume" className="space-y-3 rounded-md border p-3"><h4 className="font-medium">Expand volume</h4><p className="text-sm text-muted-foreground">Re-register with larger requested capacity. Requires plugin expansion support; cannot shrink storage.</p><div className="grid gap-2 sm:grid-cols-2"><label className={fieldClass}>Expansion minimum bytes<Input aria-label="Expansion minimum bytes" value={min} onChange={event => setMin(event.target.value)} /></label><label className={fieldClass}>Expansion maximum bytes<Input aria-label="Expansion maximum bytes" value={max} onChange={event => setMax(event.target.value)} /></label></div><AdvancedJson label="Expansion secrets (JSON object)" value={advanced} onChange={setAdvanced} />
    <ConfirmAction label="Expand volume" description="Request increased provider storage capacity? Provider charges may apply." disabled={disabled} onConfirm={async () => { await api.post(`/csi-volumes/${encodeURIComponent(text(volume.ID))}/expand`, { RequestedCapacityMin: capacity(min), RequestedCapacityMax: capacity(max), Secrets: jsonObject(advanced) }); onChanged(); }} />
  </section>;
}
function SnapshotPanel({ api, volume, disabled }: { api: StorageApi; volume: RecordValue; disabled: boolean }) {
  const path = `/csi-volumes/${encodeURIComponent(text(volume.ID))}/snapshots`;
  const [name, setName] = React.useState("");
  const [advanced, setAdvanced] = React.useState("{}");
  const [cursor, setCursor] = React.useState("");
  const [history, setHistory] = React.useState<string[]>([]);
  const [listingSecrets, setListingSecrets] = React.useState<RecordValue>({});
  const [credentialError, setCredentialError] = React.useState<unknown>();
  const snapshots = useStorageDetail<{ items: RecordValue[]; nextToken: string }>(api, `${path}/list`, undefined, { nextToken: cursor, Secrets: listingSecrets });
  return <section aria-label="Volume snapshots" className="space-y-3 rounded-md border p-3"><h4 className="font-medium">Provider snapshots</h4><ErrorMessage error={snapshots.error} />{snapshots.value && <>
    <StorageTable rows={snapshots.value.items} columns={["ID", "ExternalSourceVolumeID", "SizeBytes", "IsReady", "CreateTime"]} />
    {snapshots.value.items.map(snapshot => <div className="flex flex-wrap items-center gap-2" key={text(snapshot.ID)}><span className="break-all text-sm">{text(snapshot.ID)}</span><ConfirmAction label={`Delete snapshot ${text(snapshot.ID)}`} description="Permanently delete this provider snapshot?" danger disabled={disabled} onConfirm={async () => { const extra = jsonObject(advanced); await api.post(`${path}/delete`, { ID: snapshot.ID, nextToken: cursor || undefined, Secrets: extra.Secrets ?? {} }); snapshots.refresh(); }} /></div>)}
    <div className="flex gap-2"><Button variant="outline" disabled={!history.length} onClick={() => { setCursor(history[history.length - 1]); setHistory(history.slice(0, -1)); }}>Previous snapshots</Button><Button variant="outline" disabled={!snapshots.value.nextToken} onClick={() => { setHistory([...history, cursor]); setCursor(snapshots.value!.nextToken); }}>Next snapshots</Button></div>
  </>}
    <label className={fieldClass}>Snapshot name<Input aria-label="Snapshot name" value={name} onChange={event => setName(event.target.value)} /></label>
    <AdvancedJson label="Snapshot parameters and secrets (JSON)" value={advanced} onChange={setAdvanced} />
    <ConfirmAction label="Create snapshot" description="Create a provider snapshot of this volume? Provider charges may apply." disabled={disabled || !name.trim()} onConfirm={async () => { await api.post(path, { ...jsonObject(advanced), Name: name }); snapshots.refresh(); }} />
    <Button variant="outline" onClick={() => { try { const extra = jsonObject(advanced); setListingSecrets(jsonObject(JSON.stringify(extra.Secrets ?? {}))); setCursor(""); setHistory([]); setCredentialError(undefined); snapshots.refresh(); } catch (cause) { setCredentialError(cause); } }}>Apply snapshot listing credentials</Button><ErrorMessage error={credentialError} />
    <p className="text-xs text-muted-foreground">Snapshot support depends on the CSI provider. Provider pages may contain snapshots of other volumes; only snapshots of this volume are shown.</p>
  </section>;
}
function VolumeDetail({ api, kind, id, props, onChanged }: { api: StorageApi; kind: VolumeKind; id: string; props: PageProps; onChanged: () => void }) {
  const endpoint = `/${kind}-volumes/${encodeURIComponent(id)}`;
  const detail = useStorageDetail<RecordValue>(api, endpoint);
  const [force, setForce] = React.useState(false);
  const [secrets, setSecrets] = React.useState("{}");
  return <section className="space-y-3" aria-label="Volume detail"><h3 className="break-words font-semibold">{kind === "csi" ? "CSI" : "Dynamic host"} volume: {id}</h3><ErrorMessage error={detail.error} />{detail.value && <>
    <Fields value={detail.value} names={["ID", "Name", "Namespace", "PluginID", ...(kind === "csi" ? ["ExternalID", "Capacity", "Schedulable", "Provider", "ControllersHealthy", "ControllersExpected", "NodesHealthy", "NodesExpected"] : ["NodeID", "NodePool", "HostPath", "CapacityBytes", "State"])]} />
    <div className="flex flex-wrap gap-2">{kind === "csi" && <Button variant="outline" onClick={() => props.onNavigate("volumes", `plugin:${text(detail.value!.PluginID)}`, props.namespace)}>Inspect CSI plugin</Button>}{kind === "host" && detail.value.NodeID != null && <Button variant="outline" onClick={() => props.onNavigate("nodes", text(detail.value!.NodeID), props.namespace)}>Inspect node</Button>}</div>
    <h4 className="font-medium">Claims and allocations</h4><Links allocations={detail.value.Allocations} onNavigate={props.onNavigate} />
    <StorageTable rows={records(detail.value.RequestedCapabilities)} columns={["AttachmentMode", "AccessMode"]} />
    {kind === "csi" && <><Expansion api={api} volume={detail.value} disabled={!props.canManage} onChanged={detail.refresh} /><SnapshotPanel api={api} volume={detail.value} disabled={!props.canManage} /></>}
    <section className="space-y-3 rounded-md border border-destructive/40 p-3"><h4 className="font-medium">Volume lifecycle</h4><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={force} disabled={!props.canManage} onChange={event => setForce(event.target.checked)} />Force {kind === "csi" ? "deregistration" : "deletion"} (may disrupt allocations)</label>
      <ConfirmAction label={kind === "csi" ? "Deregister volume" : "Delete host volume"} description={kind === "csi" ? "Remove this volume from Nomad. Provider storage is NOT deleted. Active claims may prevent deregistration." : "Permanently delete storage on the client and remove its registration? Data can be lost."} danger disabled={!props.canManage} onConfirm={async () => { await api.del(endpoint, { force: String(force) }); onChanged(); props.onNavigate("volumes"); }} />
      {kind === "csi" && <><AdvancedJson label="Provider deletion secrets (JSON object)" value={secrets} onChange={setSecrets} /><ConfirmAction label="Delete provider volume" description={`Permanently delete provider storage ${text(detail.value.ExternalID)}? This is not just deregistration; stored data will be destroyed.`} danger disabled={!props.canManage} onConfirm={async () => { await api.post(`${endpoint}/delete`, { Secrets: jsonObject(secrets) }); detail.refresh(); onChanged(); }} /></>}
    </section><JsonView value={detail.value} />
  </>}{!detail.value && !detail.error && <p role="status">Loading volume...</p>}</section>;
}
function PluginDetail({ api, id, namespace, onNavigate }: { api: StorageApi; id: string; namespace: string; onNavigate: PageProps["onNavigate"] }) {
  const detail = useStorageDetail<RecordValue>(api, `/csi-plugins/${encodeURIComponent(id)}`);
  return <section className="space-y-3" aria-label="CSI plugin detail"><h3 className="break-words font-semibold">CSI plugin: {id}</h3><ErrorMessage error={detail.error} />{detail.value && <>
    <Fields value={detail.value} names={["ID", "Provider", "Version", "ControllerRequired", "ControllersHealthy", "ControllersExpected", "NodesHealthy", "NodesExpected"]} />
    {(["Controllers", "Nodes"] as const).map(field => <section className="space-y-2" key={field}><h4 className="font-medium">{field}</h4>{Object.entries((detail.value![field] ?? {}) as Record<string, RecordValue>).map(([node, info]) => <div className="space-y-2 rounded border p-2" key={node}><Button variant="outline" onClick={() => onNavigate("nodes", node, namespace)}>{node}</Button><Fields value={info} names={["Healthy", "HealthDescription", "PluginID", "Provider", "ProviderVersion"]} /><JsonView value={info} /></div>)}</section>)}
    <h4 className="font-medium">Plugin allocations</h4><Links allocations={detail.value.Allocations} onNavigate={onNavigate} /><JsonView value={detail.value} />
  </>}</section>;
}
export function VolumesContent(props: PageProps) {
  const api = useResourceApi(props.hostId, props.namespace);
  const [kind, setKind] = React.useState<VolumeKind | "plugin">("csi");
  const [creating, setCreating] = React.useState(false);
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  const selected = props.selectedId;
  const selectedKind = selected?.startsWith("host:") ? "host" : selected?.startsWith("plugin:") ? "plugin" : "csi";
  const selectedID = selected?.replace(/^(csi|host|plugin):/, "");
  const active = selected ? selectedKind : kind;
  const concrete = props.namespace !== "*";
  return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">Storage</h2>{active !== "plugin" && <Button disabled={!props.canManage || !concrete} onClick={() => { setKind(active); setCreating(!creating); props.onNavigate("volumes"); }}>Create or register volume</Button>}</div>
    <nav aria-label="Storage resources" className="flex flex-wrap gap-2">{(["csi", "host", "plugin"] as const).map(tab => <Button variant={active === tab ? "default" : "outline"} key={tab} onClick={() => { setKind(tab); setCreating(false); props.onNavigate("volumes"); }}>{tab === "csi" ? "CSI volumes" : tab === "host" ? "Dynamic host volumes" : "CSI plugins"}</Button>)}</nav>
    <ResourceBrowser key={`${active}:${revision}`} api={api} endpoint={active === "plugin" ? "/csi-plugins" : `/${active}-volumes`} title={active === "plugin" ? "CSI plugins" : "Volumes"} selectedId={selectedID} columns={active === "plugin" ? [{ key: "ID", title: "Plugin" }, { key: "Provider", title: "Provider" }, { key: "ControllersHealthy", title: "Healthy controllers" }, { key: "NodesHealthy", title: "Healthy nodes" }] : [{ key: "ID", title: "ID" }, { key: "Name", title: "Name" }, { key: "Namespace", title: "Namespace" }, { key: "PluginID", title: "Plugin" }, { key: active === "host" ? "State" : "Schedulable", title: "Status" }, { key: active === "host" ? "CapacityBytes" : "Capacity", title: "Bytes" }]} onSelect={row => { setCreating(false); props.onNavigate("volumes", `${active}:${text(row.ID)}`, typeof row.Namespace === "string" ? row.Namespace : props.namespace); }} />
    {creating && active !== "plugin" && concrete && <VolumeForm key={`${props.namespace}:${active}`} api={api} kind={active} canManage={props.canManage} onSaved={refresh} />}
    {selectedID && active === "plugin" && <PluginDetail key={`${props.hostId}:${props.namespace}:${selectedID}`} api={api} id={selectedID} namespace={props.namespace} onNavigate={props.onNavigate} />}
    {selectedID && active !== "plugin" && concrete && <VolumeDetail key={`${props.hostId}:${props.namespace}:${active}:${selectedID}`} api={api} kind={active} id={selectedID} props={props} onChanged={refresh} />}
    {!concrete && <p role="status">Choose a concrete namespace for volume details and mutations.</p>}
  </div>;
}
