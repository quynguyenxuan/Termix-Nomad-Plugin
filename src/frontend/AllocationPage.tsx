import React from "react";
import { Button, Input, Card, CardHeader, CardTitle, CardContent } from "@termix-ssh/plugin-sdk/ui";
import { ConfirmAction, ErrorMessage, JsonView, LiveText, ResourceBrowser, useRefreshTick, useResourceApi, type PageProps } from "./ResourceUI";
import { ExecTerminal } from "./ExecTerminal";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue { return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {}; }
function text(value: unknown): string { return value === undefined || value === null ? "-" : String(value); }
function entries(value: unknown): [string, ObjectValue][] { return Object.entries(object(value)).map(([name, item]) => [name, object(item)]); }

export function AllocationsPage(props: PageProps) {
  const api = useResourceApi(props.hostId, props.namespace);
  return <div className="space-y-4">
    <ResourceBrowser api={api} endpoint="/allocations" title="Allocations" selectedId={props.selectedId} onSelect={row => props.onNavigate("allocations", text(row.ID), text(row.Namespace))} columns={[
      { key: "Name", title: "Allocation", render: row => text(row.Name || row.ID) },
      { key: "Namespace", title: "Namespace" }, { key: "JobID", title: "Job" }, { key: "TaskGroup", title: "Task group" },
      { key: "ClientStatus", title: "Client status" }, { key: "DesiredStatus", title: "Desired status" }, { key: "NodeID", title: "Node" },
    ]} />
    {props.selectedId && <AllocationDetail key={`${props.hostId}/${props.namespace}/${props.selectedId}`} {...props} allocationId={props.selectedId} />}
  </div>;
}
function AllocationDetail({ allocationId, ...props }: PageProps & { allocationId: string }) {
  const api = useResourceApi(props.hostId, props.namespace);
  const tick = useRefreshTick();
  const [allocation, setAllocation] = React.useState<ObjectValue | null>(null);
  const [stats, setStats] = React.useState<ObjectValue | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [statsError, setStatsError] = React.useState<unknown>(null);
  const [task, setTask] = React.useState("");
  const [tab, setTab] = React.useState("tasks");
  const [stream, setStream] = React.useState("stdout");
  const [refresh, setRefresh] = React.useState(0);
  const path = `/allocations/${encodeURIComponent(allocationId)}`;
  React.useEffect(() => {
    let current = true;
    void api.get<ObjectValue>(path).then(value => {
      if (!current) return;
      setAllocation(value); setError(null);
      setTask(previous => Object.hasOwn(object(value.TaskStates), previous) ? previous : Object.keys(object(value.TaskStates))[0] || "");
    }).catch(cause => { if (current) setError(cause); });
    void api.get<ObjectValue>(`${path}/stats`).then(value => { if (current) { setStats(value); setStatsError(null); } }).catch(cause => { if (current) setStatsError(cause); });
    return () => { current = false; };
  }, [api, path, tick, refresh]);
  const changed = async (suffix: string, body?: unknown) => { await api.post(`${path}${suffix}`, body); setRefresh(n => n + 1); };
  const tasks = entries(allocation?.TaskStates);
  const resources = object(allocation?.AllocatedResources);
  const concrete = props.namespace !== "*";
  return <Card><CardHeader><CardTitle className="break-all">{text(allocation?.Name || allocationId)}</CardTitle></CardHeader><CardContent className="space-y-4">
    <ErrorMessage error={error} />
    {!allocation ? <p role="status">Loading allocation...</p> : <>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        {[["ID", allocationId], ["Namespace", allocation.Namespace], ["Client status", allocation.ClientStatus], ["Desired status", allocation.DesiredStatus], ["Task group", allocation.TaskGroup], ["Client description", allocation.ClientDescription]].map(([label, value]) => <div key={text(label)} className="break-words"><dt className="text-muted-foreground">{text(label)}</dt><dd>{text(value)}</dd></div>)}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => props.onNavigate("jobs", text(allocation.JobID), text(allocation.Namespace))}>Job: {text(allocation.JobID)}</Button>
        <Button variant="outline" onClick={() => props.onNavigate("nodes", text(allocation.NodeID), text(allocation.Namespace))}>Node: {text(allocation.NodeID)}</Button>
        {Boolean(allocation.EvalID) && <Button variant="outline" onClick={() => props.onNavigate("evaluations", text(allocation.EvalID), text(allocation.Namespace))}>Evaluation</Button>}
        {Boolean(allocation.DeploymentID) && <Button variant="outline" onClick={() => props.onNavigate("deployments", text(allocation.DeploymentID), text(allocation.Namespace))}>Deployment</Button>}
        <Button variant="outline" onClick={() => setRefresh(n => n + 1)}>Refresh allocation</Button>
        {props.canManage && <><ConfirmAction label="Restart all tasks" description="Restart every task, including lifecycle tasks, in lifecycle order?" disabled={!concrete} onConfirm={() => changed("/restart", { allTasks: true })} /><ConfirmAction label="Stop allocation" description="Stop this allocation? Nomad may schedule a replacement according to the job policy." disabled={!concrete} danger onConfirm={() => changed("/stop")} /></>}
      </div>
      {!concrete && <p className="text-sm">Choose a concrete namespace to restart, stop or exec.</p>}
      <nav aria-label="Allocation sections" className="flex flex-wrap gap-2">{["tasks", "resources", "logs", "files", ...(props.canExec ? ["exec"] : [])].map(name => <Button key={name} variant={tab === name ? "secondary" : "outline"} onClick={() => setTab(name)}>{name[0].toUpperCase() + name.slice(1)}</Button>)}</nav>
      {(tab === "logs" || tab === "exec") && <label className="block text-sm">Task <select aria-label="Allocation task" className="h-9 max-w-full rounded border border-input bg-background px-2" value={task} onChange={event => setTask(event.target.value)}>{tasks.map(([name]) => <option key={name}>{name}</option>)}</select></label>}
      {tab === "tasks" && <section aria-label="Allocation tasks" className="space-y-3">{tasks.length === 0 && <p>No tasks reported.</p>}{tasks.map(([name, state]) => <section key={name} className="space-y-2 rounded border border-border p-3"><h3 className="break-words font-medium">{name}: {text(state.State)}{state.Failed ? " (failed)" : ""}</h3><p className="text-sm">Restarts: {text(state.Restarts)} / Started: {text(state.StartedAt)} / Finished: {text(state.FinishedAt)}</p><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { setTask(name); setTab("logs"); }}>View logs</Button>{props.canExec && <Button variant="outline" onClick={() => { setTask(name); setTab("exec"); }}>Exec task</Button>}{props.canManage && <ConfirmAction label={`Restart ${name}`} description={`Restart task ${name}?`} disabled={!concrete} onConfirm={() => changed("/restart", { task: name })} />}</div><h4 className="text-sm font-medium">Events</h4><div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>Time</th><th>Type</th><th>Message</th><th>Exit</th></tr></thead><tbody>{(Array.isArray(state.Events) ? state.Events : []).map((event, index) => { const item = object(event); return <tr key={index}><td className="align-top pr-3">{typeof item.Time === "number" ? new Date(item.Time / 1e6).toLocaleString() : text(item.Time)}</td><td className="align-top pr-3">{text(item.Type)}</td><td className="break-words pr-3">{text(item.DisplayMessage || item.Message || item.DriverError || item.KillError)}</td><td>{text(item.ExitCode)}</td></tr>; })}</tbody></table></div></section>)}</section>}
      {tab === "resources" && <section className="space-y-3"><h3 className="font-medium">Allocated resources</h3><div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>Task</th><th>CPU shares</th><th>Memory MiB</th><th>Memory max MiB</th></tr></thead><tbody>{entries(resources.Tasks).map(([name, value]) => <tr key={name}><td>{name}</td><td>{text(object(value.Cpu).CpuShares)}</td><td>{text(object(value.Memory).MemoryMB)}</td><td>{text(object(value.Memory).MemoryMaxMB)}</td></tr>)}</tbody></table></div><p className="text-sm">Shared disk MiB: {text(object(resources.Shared).DiskMB)}</p><h3 className="font-medium">Live usage</h3><ErrorMessage error={statsError} />{stats && <><Usage name="Allocation total" value={object(stats.ResourceUsage)} />{entries(stats.Tasks).map(([name, value]) => <Usage key={name} name={name} value={object(value.ResourceUsage)} />)}</>}<h3 className="font-medium">Network interfaces</h3>{(Array.isArray(object(resources.Shared).Networks) ? object(resources.Shared).Networks as unknown[] : []).map((network, index) => { const item = object(network); return <p key={index} className="break-words text-sm">{text(item.Device)} / {text(item.IP)} / {text(item.CIDR)} / {text(item.MBits)} Mbit/s</p>; })}<JsonView value={{ AllocatedResources: allocation.AllocatedResources, Resources: allocation.Resources, Stats: stats }} /></section>}
      {tab === "logs" && <section className="space-y-3"><label className="text-sm">Log stream <select aria-label="Log stream" className="h-9 rounded border border-input bg-background px-2" value={stream} onChange={event => setStream(event.target.value)}><option>stdout</option><option>stderr</option></select></label>{task ? <LiveText api={api} path={`${path}/logs/stream`} query={{ task, type: stream }} /> : <p>No task logs available.</p>}</section>}
      {tab === "files" && <AllocationFiles hostId={props.hostId} namespace={props.namespace} allocationId={allocationId} />}
      {tab === "exec" && props.canExec && task && <ExecTerminal key={`${allocationId}/${task}`} hostId={props.hostId} namespace={props.namespace} allocationId={allocationId} task={task} socketUrl={props.socketUrl} />}
      <JsonView value={allocation} />
    </>}
  </CardContent></Card>;
}
function Usage({ name, value }: { name: string; value: ObjectValue }) {
  const cpu = object(value.CpuStats); const memory = object(value.MemoryStats);
  return <div className="rounded border border-border p-3 text-sm"><h4 className="font-medium">{name}</h4><p>CPU: {text(cpu.Percent)}% / {text(cpu.TotalTicks)} ticks</p><p>Memory RSS: {typeof memory.RSS === "number" ? `${(memory.RSS / 1048576).toFixed(2)} MiB` : "-"} / Cache: {typeof memory.Cache === "number" ? `${(memory.Cache / 1048576).toFixed(2)} MiB` : "-"}</p></div>;
}
function AllocationFiles({ hostId, namespace, allocationId }: { hostId: string; namespace: string; allocationId: string }) {
  const api = useResourceApi(hostId, namespace);
  const [input, setInput] = React.useState(".");
  const [directory, setDirectory] = React.useState(".");
  const [files, setFiles] = React.useState<ObjectValue[]>([]);
  const [file, setFile] = React.useState("");
  const [stat, setStat] = React.useState<ObjectValue | null>(null);
  const [content, setContent] = React.useState("");
  const [offset, setOffset] = React.useState("0");
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const [refresh, setRefresh] = React.useState(0);
  const inspection = React.useRef(0);
  const path = `/allocations/${encodeURIComponent(allocationId)}/fs`;
  React.useEffect(() => {
    let current = true;
    inspection.current++;
    setBusy(false);
    setError(null);
    void api.get<ObjectValue[]>(`${path}/ls`, { path: directory }).then(value => { if (current) setFiles(value); }).catch(cause => { if (current) { setError(cause); setFiles([]); } });
    return () => { current = false; inspection.current++; };
  }, [api, path, directory, refresh]);
  async function inspect(name: string, readOffset = "0") {
    const request = ++inspection.current;
    setBusy(true); setError(null); setContent("");
    try {
      const value = await api.get<ObjectValue>(`${path}/stat`, { path: name });
      if (request !== inspection.current) return;
      setStat(value); setFile(name); setOffset(readOffset);
      const result = await api.get<{ text: string }>(`${path}/read`, { path: name, offset: readOffset, limit: "65536" });
      if (request === inspection.current) setContent(result.text);
    } catch (cause) { if (request === inspection.current) setError(cause); } finally { if (request === inspection.current) setBusy(false); }
  }
  async function download() {
    setBusy(true); setError(null);
    try {
      const blob = await api.download(`${path}/download`, { path: file });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.split("/").pop() || "download"; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  return <section aria-label="Allocation filesystem" className="space-y-3"><h3 className="font-medium">Filesystem</h3><p className="text-sm text-muted-foreground">Paths are relative to this allocation. Text previews read at most 64 KiB; binary downloads support files up to 64 MiB.</p><form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setDirectory(input); setRefresh(n => n + 1); setFile(""); }}><label className="min-w-0 flex-1 text-sm">Directory<Input aria-label="Allocation directory" value={input} onChange={event => setInput(event.target.value)} /></label><Button variant="outline" type="submit">List directory</Button><Button variant="outline" type="button" onClick={() => { const parent = directory.split("/").slice(0, -1).join("/") || "."; setDirectory(parent); setInput(parent); setFile(""); }}>Parent directory</Button></form><ErrorMessage error={error} /><div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>Name</th><th>Bytes</th><th>Mode</th><th>Modified</th></tr></thead><tbody>{files.map((item, index) => <tr key={index}><td><Button variant="ghost" disabled={busy} onClick={() => { const name = `${directory === "." ? "" : `${directory}/`}${text(item.Name)}`; if (item.IsDir) { setDirectory(name); setInput(name); setFile(""); } else void inspect(name); }}>{item.IsDir ? "[dir] " : ""}{text(item.Name)}</Button></td><td>{text(item.Size)}</td><td>{text(item.FileMode)}</td><td>{text(item.ModTime)}</td></tr>)}</tbody></table></div>{files.length === 0 && <p className="text-sm">No files returned.</p>}{file && <section className="space-y-3"><h4 className="break-words font-medium">{file}</h4><p className="text-sm">{text(stat?.Size)} bytes / {text(stat?.ContentType)} / {text(stat?.FileMode)}</p><form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (/^\d+$/.test(offset) && Number.isSafeInteger(Number(offset))) void inspect(file, offset); else setError(new Error("Offset must be a nonnegative safe integer")); }}><label className="text-sm">Byte offset<Input aria-label="File byte offset" type="number" min={0} step={1} value={offset} onChange={event => setOffset(event.target.value)} /></label><Button variant="outline" disabled={busy}>Read 64 KiB</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void download()}>Download file</Button></form><pre aria-label="File preview" className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted p-3 font-mono text-xs">{content || "No text content."}</pre></section>}</section>;
}
