import React from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@termix-ssh/plugin-sdk/ui";
import { ConfirmAction, ErrorMessage, JsonEditor, JsonView, LiveText, ResourceBrowser, useRefreshTick, useResourceApi, type PageProps, type ResourceApi as Api } from "./ResourceUI";

type Row = Record<string, unknown>;
type Page = { items: Row[]; nextToken: string };
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string => value == null ? "-" : typeof value === "object" ? JSON.stringify(value) : String(value);
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const bytes = (value: unknown): string => `${(number(value) / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
const segment = (value: unknown): string => encodeURIComponent(String(value));
function useData<T>(api: Api, path: string | undefined, refresh = 0, query?: Record<string, string>) {
  const tick = useRefreshTick();
  const queryKey = JSON.stringify(query ?? {});
  const [data, setData] = React.useState<T>();
  const [error, setError] = React.useState<unknown>();
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => { setData(undefined); }, [api, path, queryKey]);
  React.useEffect(() => {
    let active = true;
    setError(undefined);
    if (!path) return;
    setLoading(true);
    void api.get<T>(path, JSON.parse(queryKey)).then(value => { if (active) setData(value); }).catch(cause => { if (active) setError(cause); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, path, refresh, tick, queryKey]);
  return { data, error, loading };
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent className="space-y-3">{children}</CardContent></Card>;
}
function Fields({ value }: { value: Row }) {
  return <dl className="grid gap-2 text-sm sm:grid-cols-2">{Object.entries(value).map(([key, item]) => <div key={key} className="min-w-0"><dt className="text-muted-foreground">{key}</dt><dd className="break-words">{text(item)}</dd></div>)}</dl>;
}
function DataTable({ values, columns }: { values: Row[]; columns: string[] }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{columns.map(key => <th className="p-2" key={key} scope="col">{key}</th>)}</tr></thead><tbody>{values.map((value, i) => <tr className="border-t border-border" key={String(value.ID ?? value.Name ?? i)}>{columns.map(key => <td className="max-w-sm break-words p-2" key={key}>{text(value[key])}</td>)}</tr>)}</tbody></table>{values.length === 0 && <p className="text-sm text-muted-foreground">No records returned.</p>}</div>;
}
function Usage({ stats }: { stats: Row }) {
  const memory = record(stats.Memory);
  const cpus = rows(stats.CPU);
  return <><Fields value={{ "Memory used": bytes(memory.Used), "Memory total": bytes(memory.Total), "CPU busy": cpus.length ? `${(cpus.reduce((sum, cpu) => sum + 100 - number(cpu.Idle), 0) / cpus.length).toFixed(1)}%` : "Unavailable", "CPU ticks consumed": stats.CPUTicksConsumed, "Uptime seconds": stats.Uptime }} /><DataTable values={rows(stats.DiskStats)} columns={["Device", "Mountpoint", "Size", "Used", "UsedPercent"]} /></>;
}

export function DashboardPage(props: PageProps) {
  const api = useResourceApi(props.hostId, props.namespace);
  const [nodeCursor, setNodeCursor] = React.useState("");
  const [allocationCursor, setAllocationCursor] = React.useState("");
  const nodes = useData<Page>(api, "/nodes", 0, { per_page: "50", next_token: nodeCursor });
  const allocations = useData<Page>(api, "/dashboard/allocations", 0, { per_page: "200", next_token: allocationCursor });
  const [stats, setStats] = React.useState<Record<string, Row>>({});
  const [statErrors, setStatErrors] = React.useState<Record<string, unknown>>({});
  React.useEffect(() => {
    let active = true;
    setStats({}); setStatErrors({});
    const pending = [...(nodes.data?.items ?? [])];
    async function worker() {
      while (active && pending.length) {
        const node = pending.shift()!;
        const key = String(node.ID);
        try { const value = await api.get<Row>(`/nodes/${segment(key)}/stats`); if (active) setStats(current => ({ ...current, [key]: value })); }
        catch (cause) { if (active) setStatErrors(current => ({ ...current, [key]: cause })); }
      }
    }
    void Promise.all(Array.from({ length: Math.min(5, pending.length) }, worker));
    return () => { active = false; };
  }, [api, nodes.data]);
  const groups = new Map<string, Row[]>();
  for (const node of nodes.data?.items ?? []) {
    const group = `${text(node.Datacenter)} / ${text(node.NodePool)}`;
    groups.set(group, [...(groups.get(group) ?? []), node]);
  }
  const measurements = Object.values(stats);
  const totalMemory = measurements.reduce((sum, item) => sum + number(record(item.Memory).Total), 0);
  const usedMemory = measurements.reduce((sum, item) => sum + number(record(item.Memory).Used), 0);
  const cpuMeasurements = measurements.flatMap(item => rows(item.CPU));
  const cpuBusy = cpuMeasurements.length ? `${(cpuMeasurements.reduce((sum, cpu) => sum + 100 - number(cpu.Idle), 0) / cpuMeasurements.length).toFixed(1)}%` : "Unavailable";
  const capacityCPU = (nodes.data?.items ?? []).reduce((sum, node) => sum + number(record(record(node.NodeResources).Cpu).CpuShares), 0);
  const capacityMemory = (nodes.data?.items ?? []).reduce((sum, node) => sum + number(record(record(node.NodeResources).Memory).MemoryMB), 0);
  return <div className="space-y-4">
    <Panel title="Cluster resource utilization"><p className="text-sm text-muted-foreground">Live host statistics and placement for the visible node page and allocation page, not cluster-wide totals. Allocation placement may be incomplete when another allocation page exists.</p>
      <ErrorMessage error={nodes.error} /><ErrorMessage error={allocations.error} />
      {(nodes.loading || allocations.loading) && <p role="status">Loading topology...</p>}
      <Fields value={{ "Visible clients": nodes.data?.items.length ?? 0, "Visible allocations": allocations.data?.items.length ?? 0, "CPU capacity (MHz)": capacityCPU, "Memory capacity (MiB)": capacityMemory, "Reporting hosts": `${measurements.length} / ${nodes.data?.items.length ?? 0}`, "Live host CPU busy": cpuBusy, "Live host memory": measurements.length ? `${bytes(usedMemory)} / ${bytes(totalMemory)}` : "Unavailable", "Host memory utilization": totalMemory ? `${(100 * usedMemory / totalMemory).toFixed(1)}%` : "Unavailable" }} />
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!nodeCursor} onClick={() => setNodeCursor("")}>First node page</Button><Button variant="outline" disabled={!nodes.data?.nextToken} onClick={() => setNodeCursor(nodes.data!.nextToken)}>Next node page</Button><Button variant="outline" disabled={!allocationCursor} onClick={() => setAllocationCursor("")}>First allocation page</Button><Button variant="outline" disabled={!allocations.data?.nextToken} onClick={() => setAllocationCursor(allocations.data!.nextToken)}>Next allocation page</Button></div>
    </Panel>
    {[...groups].map(([group, clients]) => <Panel title={`Datacenter / pool: ${group}`} key={group}><div className="grid gap-3 lg:grid-cols-2">{clients.map(node => {
      const key = String(node.ID);
      const placed = (allocations.data?.items ?? []).filter(allocation => allocation.NodeID === node.ID);
      return <article className="min-w-0 space-y-2 rounded border border-border p-3" key={key}><Button variant="link" className="h-auto max-w-full whitespace-normal break-all p-0" onClick={() => props.onNavigate("nodes", key)}>{text(node.Name)} / {text(node.Status)}</Button><Fields value={{ Eligibility: node.SchedulingEligibility, Draining: node.Drain, "Placed allocations on page": placed.length, "Host memory used": stats[key] ? bytes(record(stats[key].Memory).Used) : "Unavailable" }} /><ErrorMessage error={statErrors[key]} /><div className="flex flex-wrap gap-2">{placed.map(allocation => <Button variant="outline" className="h-auto whitespace-normal break-all" key={String(allocation.ID)} onClick={() => props.onNavigate("allocations", String(allocation.ID), String(allocation.Namespace))}>{text(allocation.Name ?? allocation.ID)} / {text(allocation.ClientStatus)}</Button>)}</div></article>;
    })}</div></Panel>)}
  </div>;
}

export function NodesPage(props: PageProps) {
  const api = useResourceApi(props.hostId, props.namespace);
  return <div className="space-y-4"><ResourceBrowser api={api} endpoint="/nodes" title="Clients" selectedId={props.selectedId} onSelect={node => props.onNavigate("nodes", String(node.ID))} columns={[{ key: "Name", title: "Client" }, { key: "Datacenter", title: "Datacenter" }, { key: "NodePool", title: "Pool" }, { key: "Status", title: "Status" }, { key: "SchedulingEligibility", title: "Eligibility" }, { key: "Drain", title: "Draining" }]} />{props.selectedId && <NodeDetail key={`${props.hostId}/${props.namespace}/${props.selectedId}`} {...props} api={api} />}</div>;
}
function NodeDetail(props: PageProps & { api: Api }) {
  const path = `/nodes/${segment(props.selectedId)}`;
  const [revision, setRevision] = React.useState(0);
  const node = useData<Row>(props.api, path, revision);
  const stats = useData<Row>(props.api, `${path}/stats`, revision);
  const allocations = useData<Row[]>(props.api, `${path}/allocations`, revision);
  const [deadline, setDeadline] = React.useState("3600");
  const [ignoreSystem, setIgnoreSystem] = React.useState(false);
  const [markEligible, setMarkEligible] = React.useState(false);
  const [monitor, setMonitor] = React.useState(false);
  const [level, setLevel] = React.useState("info");
  const monitorQuery = React.useMemo(() => ({ level }), [level]);
  const value = node.data;
  return <><Panel title="Client details"><ErrorMessage error={node.error} />{node.loading && <p role="status">Loading client...</p>}{value && <>
    <Fields value={{ ID: value.ID, Name: value.Name, Status: value.Status, Description: value.StatusDescription, Datacenter: value.Datacenter, Pool: value.NodePool, Class: value.NodeClass, Eligibility: value.SchedulingEligibility, Draining: value.Drain, "Drain strategy": value.DrainStrategy, "Last drain": value.LastDrain }} />
    <h3 className="font-medium">Node resource capacity</h3><Fields value={{ "CPU capacity (MHz)": record(record(value.NodeResources).Cpu).CpuShares, "Memory capacity (MiB)": record(record(value.NodeResources).Memory).MemoryMB, "Disk capacity (MiB)": record(record(value.NodeResources).Disk).DiskMB, "Reserved CPU (MHz)": record(record(value.ReservedResources).Cpu).CpuShares, "Reserved memory (MiB)": record(record(value.ReservedResources).Memory).MemoryMB }} />
    <Button variant="link" onClick={() => props.onNavigate("node-pools", String(value.NodePool))}>Open node pool</Button>
    {props.canAdmin ? <div className="space-y-3 rounded border border-border p-3"><h3 className="font-medium">Scheduling controls</h3><div className="flex flex-wrap items-end gap-3"><label className="text-sm">Drain deadline (seconds; 0 means no deadline)<Input aria-label="Drain deadline seconds" type="number" min="0" max="9007199" step="1" value={deadline} onChange={event => setDeadline(event.target.value)} /></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ignoreSystem} onChange={event => setIgnoreSystem(event.target.checked)} />Keep system jobs during drain</label></div>
    <ConfirmAction label="Start drain" description="Mark this node ineligible and migrate allocations. A deadline can force remaining allocations to stop." disabled={!/^\d+$/.test(deadline) || !Number.isSafeInteger(Number(deadline) * 1e9)} danger onConfirm={async () => { await props.api.put(`${path}/drain`, { enabled: true, deadlineSeconds: Number(deadline), ignoreSystemJobs: ignoreSystem, markEligible: false }); setRevision(value => value + 1); }} />
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={markEligible} onChange={event => setMarkEligible(event.target.checked)} />Also mark eligible when canceling drain</label>
    <ConfirmAction label="Cancel drain" description="Stop the drain strategy. Already stopped or migrated allocations are not restored." disabled={!value.Drain && !value.DrainStrategy} onConfirm={async () => { await props.api.put(`${path}/drain`, { enabled: false, markEligible }); setRevision(value => value + 1); }} />
    <ConfirmAction label={value.SchedulingEligibility === "eligible" ? "Mark ineligible" : "Mark eligible"} description="Change whether the scheduler may place new allocations on this node." onConfirm={async () => { await props.api.put(`${path}/eligibility`, { eligible: value.SchedulingEligibility !== "eligible" }); setRevision(value => value + 1); }} />
    </div> : <p className="text-sm text-muted-foreground">Cluster administration permission is required to change scheduling.</p>}
    <h3 className="font-medium">Metadata</h3><Fields value={record(value.Meta)} /><h3 className="font-medium">Attributes</h3><Fields value={record(value.Attributes)} />
    <h3 className="font-medium">Drivers</h3><DataTable values={Object.entries(record(value.Drivers)).map(([Name, driver]) => ({ Name, ...record(driver) }))} columns={["Name", "Detected", "Healthy", "HealthDescription", "UpdateTime", "Attributes"]} />
    <h3 className="font-medium">Events</h3><DataTable values={rows(value.Events)} columns={["Timestamp", "Subsystem", "Message", "Details"]} /><JsonView value={value} /></>}</Panel>
    <Panel title="Live client statistics"><ErrorMessage error={stats.error} />{stats.data && <Usage stats={stats.data} />}</Panel>
    {props.canAdmin && <Panel title="Client agent monitor">
      <label className="text-sm">Client log level <select aria-label="Client log level" className="ml-2 rounded border border-border bg-background p-2" value={level} onChange={event => setLevel(event.target.value)}>{["trace", "debug", "info", "warn", "error"].map(value => <option key={value}>{value}</option>)}</select></label>
      <Button variant="outline" onClick={() => setMonitor(value => !value)}>{monitor ? "Close client monitor" : "Open client monitor"}</Button>
      {monitor && <LiveText key={level} api={props.api} path={`${path}/monitor`} query={monitorQuery} />}
    </Panel>}
    <Panel title="Client allocations"><ErrorMessage error={allocations.error} />{allocations.data?.map(allocation => <div className="flex flex-wrap items-center gap-2" key={String(allocation.ID)}><Button variant="link" className="h-auto whitespace-normal break-all" onClick={() => props.onNavigate("allocations", String(allocation.ID), String(allocation.Namespace))}>{text(allocation.Name ?? allocation.ID)}</Button><span className="text-sm">{text(allocation.ClientStatus)} / {text(allocation.Namespace)}</span><Button variant="outline" onClick={() => props.onNavigate("jobs", String(allocation.JobID), String(allocation.Namespace))}>Job {text(allocation.JobID)}</Button></div>)}</Panel></>;
}

export function ServersPage(props: PageProps) {
  const api = useResourceApi(props.hostId, props.namespace);
  const servers = useData<Row[]>(api, props.canAdmin ? "/servers" : undefined);
  const raft = useData<Row>(api, props.canAdmin ? "/servers/raft" : undefined);
  const leader = useData<{ leader: string }>(api, props.canAdmin ? "/servers/leader" : undefined);
  const self = useData<Row>(api, props.canAdmin ? "/agent/self" : undefined);
  const metrics = useData<Row>(api, props.canAdmin ? "/agent/metrics" : undefined);
  const [level, setLevel] = React.useState("info");
  const [monitor, setMonitor] = React.useState(false);
  const query = React.useMemo(() => ({ level }), [level]);
  React.useEffect(() => { setMonitor(false); }, [props.selectedId]);
  if (!props.canAdmin) return <p>Cluster administration permission is required for server diagnostics.</p>;
  const selected = servers.data?.find(server => server.Name === props.selectedId);
  return <div className="space-y-4"><Panel title="Server members"><ErrorMessage error={servers.error} /><ErrorMessage error={leader.error} /><p className="break-all text-sm">Leader: {leader.data?.leader || "Unavailable"}</p>{servers.data?.map(server => <Button key={String(server.Name)} variant={props.selectedId === server.Name ? "secondary" : "outline"} className="mr-2 h-auto whitespace-normal break-all" onClick={() => props.onNavigate("servers", String(server.Name))}>{text(server.Name)} / {text(server.Status)} / {text(server.Addr)}:{text(server.Port)}</Button>)}{selected && <><Fields value={selected} /><h3 className="font-medium">Monitor server logs</h3><label className="block text-sm">Log level<select aria-label="Server log level" className="ml-2 rounded border border-border bg-background p-2" value={level} onChange={event => setLevel(event.target.value)}>{["trace", "debug", "info", "warn", "error"].map(value => <option key={value}>{value}</option>)}</select></label><Button variant="outline" onClick={() => setMonitor(value => !value)}>{monitor ? "Close monitor" : "Open monitor"}</Button>{monitor && <LiveText key={`${props.selectedId}/${level}`} api={api} path={`/servers/${segment(props.selectedId)}/monitor`} query={query} />}</>}</Panel>
    <Panel title="Raft configuration"><ErrorMessage error={raft.error} /><p className="text-sm">Configuration index: {text(raft.data?.Index)}</p><DataTable values={rows(raft.data?.Servers)} columns={["ID", "Node", "Address", "Leader", "Voter", "RaftProtocol"]} /></Panel>
    <Panel title="Connected agent"><ErrorMessage error={self.error} />{self.data && <><Fields value={record(self.data.member)} />{Object.entries(record(self.data.stats)).map(([name, values]) => <section key={name}><h3 className="font-medium">{name}</h3><Fields value={record(values)} /></section>)}</>}</Panel>
    <Panel title="Agent metrics"><ErrorMessage error={metrics.error} />{metrics.data && <><p className="text-sm">Snapshot: {text(metrics.data.Timestamp)}</p><h3 className="font-medium">Gauges</h3><DataTable values={rows(metrics.data.Gauges)} columns={["Name", "Value", "Labels"]} /><h3 className="font-medium">Counters</h3><DataTable values={rows(metrics.data.Counters)} columns={["Name", "Count", "Rate", "Mean", "Min", "Max", "Labels"]} /><h3 className="font-medium">Samples</h3><DataTable values={rows(metrics.data.Samples)} columns={["Name", "Count", "Mean", "Stddev", "Min", "Max", "Labels"]} /><JsonView value={metrics.data} /></>}</Panel></div>;
}

export function NodePoolsPage(props: PageProps) {
  const api = useResourceApi(props.hostId, props.namespace);
  const [revision, setRevision] = React.useState(0);
  const pool = useData<Row>(api, props.selectedId ? `/node-pools/${segment(props.selectedId)}` : undefined, revision);
  return <div className="space-y-4"><ResourceBrowser key={revision} api={api} endpoint="/node-pools" title="Node pools" selectedId={props.selectedId} onSelect={value => props.onNavigate("node-pools", String(value.Name))} columns={[{ key: "Name", title: "Pool" }, { key: "Description", title: "Description" }, { key: "SchedulerConfiguration", title: "Scheduler" }]} />
    <ErrorMessage error={pool.error} />{pool.data && <Panel title={`Pool ${text(pool.data.Name)}`}><Fields value={{ Name: pool.data.Name, Description: pool.data.Description, Metadata: pool.data.Meta, "Scheduler configuration": pool.data.SchedulerConfiguration, "Node identity TTL": pool.data.NodeIdentityTTL }} /><ResourceBrowser api={api} endpoint={`/node-pools/${segment(props.selectedId)}/nodes`} title="Pool clients" onSelect={value => props.onNavigate("nodes", String(value.ID))} columns={[{ key: "Name", title: "Client" }, { key: "Status", title: "Status" }, { key: "Datacenter", title: "Datacenter" }]} /><ResourceBrowser api={api} endpoint={`/node-pools/${segment(props.selectedId)}/jobs`} title="Pool jobs" onSelect={value => props.onNavigate("jobs", String(value.ID), String(value.Namespace))} columns={[{ key: "Name", title: "Job" }, { key: "Namespace", title: "Namespace" }, { key: "Status", title: "Status" }]} /><JsonView value={pool.data} /></Panel>}
    {props.canAdmin && <><Panel title="Create node pool"><PoolForm key="create" api={api} onSaved={() => setRevision(value => value + 1)} /></Panel>{pool.data && pool.data.Name !== "all" && <Panel title="Edit node pool"><PoolForm key={`${props.hostId}/${props.selectedId}`} api={api} initial={pool.data} onSaved={() => setRevision(value => value + 1)} /><ConfirmAction label="Delete node pool" disabled={pool.data.Name === "default"} description={`Permanently delete ${text(pool.data.Name)}. Nomad refuses deletion while clients or jobs still use the pool. The default pool cannot be deleted.`} danger onConfirm={async () => { await api.del(`/node-pools/${segment(props.selectedId)}`); props.onNavigate("node-pools"); setRevision(value => value + 1); }} /></Panel>}</>}
  </div>;
}
function PoolForm({ api, initial, onSaved }: { api: Api; initial?: Row; onSaved: () => void }) {
  const [name, setName] = React.useState(String(initial?.Name ?? ""));
  const [description, setDescription] = React.useState(String(initial?.Description ?? ""));
  const [metadata, setMetadata] = React.useState<[string, string][]>(Object.entries(record(initial?.Meta)).map(([key, value]) => [key, String(value)]));
  const config = record(initial?.SchedulerConfiguration);
  const [algorithm, setAlgorithm] = React.useState(String(config.SchedulerAlgorithm ?? ""));
  const [memory, setMemory] = React.useState(config.MemoryOversubscriptionEnabled === true ? "true" : config.MemoryOversubscriptionEnabled === false ? "false" : "inherit");
  const [ttl, setTTL] = React.useState(String(initial?.NodeIdentityTTL ?? ""));
  const [error, setError] = React.useState<unknown>();
  const input = () => {
    if (metadata.some(([key]) => !key.trim()) || new Set(metadata.map(([key]) => key)).size !== metadata.length) throw new Error("Metadata keys must be nonempty and unique");
    return { ...initial, Name: name, Description: description, Meta: Object.fromEntries(metadata), ...(ttl ? { NodeIdentityTTL: ttl } : initial?.NodeIdentityTTL ? { NodeIdentityTTL: "0s" } : {}), SchedulerConfiguration: algorithm ? { SchedulerAlgorithm: algorithm, ...(memory === "inherit" ? {} : { MemoryOversubscriptionEnabled: memory === "true" }) } : null };
  };
  const save = async (value: unknown) => {
    await api.put(initial ? `/node-pools/${segment(initial.Name)}` : "/node-pools", value); onSaved();
  };
  const advanced = initial ?? { Name: "", Description: "", Meta: {}, SchedulerConfiguration: null };
  return <div className="space-y-3"><ErrorMessage error={error} /><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Pool name<Input aria-label={initial ? "Edit pool name" : "New pool name"} disabled={!!initial} value={name} maxLength={128} onChange={event => setName(event.target.value)} /></label><label className="text-sm">Description<Input aria-label={initial ? "Edit pool description" : "New pool description"} value={description} maxLength={4096} onChange={event => setDescription(event.target.value)} /></label><label className="text-sm">Scheduler algorithm<select aria-label={initial ? "Edit pool scheduler" : "New pool scheduler"} className="block w-full rounded border border-border bg-background p-2" value={algorithm} onChange={event => setAlgorithm(event.target.value)}><option value="">Cluster default</option><option value="binpack">Binpack</option><option value="spread">Spread</option></select></label><label className="text-sm">Memory oversubscription<select aria-label={initial ? "Edit pool memory oversubscription" : "New pool memory oversubscription"} disabled={!algorithm} className="block w-full rounded border border-border bg-background p-2" value={memory} onChange={event => setMemory(event.target.value)}><option value="inherit">Cluster default</option><option value="true">Enabled</option><option value="false">Disabled</option></select></label><label className="text-sm">Node identity TTL (duration)<Input aria-label={initial ? "Edit pool node identity TTL" : "New pool node identity TTL"} placeholder="Cluster default, e.g. 1h" value={ttl} onChange={event => setTTL(event.target.value)} /></label></div><p className="text-xs text-muted-foreground">Scheduler configuration and node identity settings may require a supporting Nomad version or edition. Server capability and ACL errors remain visible.</p>
    <h3 className="text-sm font-medium">Metadata</h3>{metadata.map(([key, value], index) => <div className="flex flex-wrap gap-2" key={index}><Input aria-label={`Metadata key ${index + 1}`} value={key} onChange={event => setMetadata(current => current.map((pair, i) => i === index ? [event.target.value, pair[1]] : pair))} /><Input aria-label={`Metadata value ${index + 1}`} value={value} onChange={event => setMetadata(current => current.map((pair, i) => i === index ? [pair[0], event.target.value] : pair))} /><Button variant="outline" onClick={() => setMetadata(current => current.filter((_, i) => i !== index))}>Remove metadata {index + 1}</Button></div>)}<Button variant="outline" onClick={() => setMetadata(current => [...current, ["", ""]])}>Add metadata</Button>
    <ConfirmAction label={initial ? "Update node pool" : "Create node pool"} description="Save this cluster-wide node pool configuration. Pool scheduler changes affect future placement." disabled={!/^[a-zA-Z0-9_-]{1,128}$/.test(name) || (name === "all" || (!initial && name === "default"))} onConfirm={async () => { try { setError(undefined); await save(input()); } catch (cause) { setError(cause); throw cause; } }} />
    <details><summary className="cursor-pointer text-sm">Advanced structured pool configuration</summary><p className="text-xs text-muted-foreground">The advanced editor submits its own complete definition, independently of the form. Keep Name unchanged when editing.</p><JsonEditor initialValue={advanced} label="Save advanced node pool" onSubmit={save} /></details>
  </div>;
}
