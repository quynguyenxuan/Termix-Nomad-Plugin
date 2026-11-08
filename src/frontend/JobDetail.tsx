import React from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@termix-ssh/plugin-sdk/ui";
import { errorMessage, type Allocation, type Constraint, type Job, type JobService, type JobSubmission, type NomadApi } from "./nomad-api";
import { ConfirmAction, JsonView, useRefreshTick } from "./ResourceUI";
import { JobConsulHealth } from "./ConsulIntegration";

interface Props {
  api: NomadApi;
  jobId: string;
  canManage: boolean;
  onEdit(job: Job, submission?: JobSubmission): void;
  onChanged(): void;
  onNavigate(resource: string, id?: string): void;
  children?: React.ReactNode;
}

export function JobDetail({ api, jobId, canManage, onEdit, onChanged, onNavigate, children }: Props) {
  const [loadedJob, setJob] = React.useState<{ api: NomadApi; jobId: string; value: Job } | null>(null);
  const [loadedAllocations, setAllocations] = React.useState<{ api: NomadApi; jobId: string; value: Allocation[] } | null>(null);
  const job = loadedJob?.api === api && loadedJob.jobId === jobId ? loadedJob.value : null;
  const allocations = loadedAllocations?.api === api && loadedAllocations.jobId === jobId ? loadedAllocations.value : [];
  const [counts, setCounts] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState("");
  const [refresh, setRefresh] = React.useState(0);
  const [sourceBusy, setSourceBusy] = React.useState(false);
  const [sourceError, setSourceError] = React.useState("");
  const sourceRevision = React.useRef(0);
  React.useEffect(() => {
    sourceRevision.current++;
    setSourceBusy(false);
    setSourceError("");
    setCounts({});
    return () => { sourceRevision.current++; };
  }, [api, jobId]);
  async function editSpecification() {
    if (!job || sourceBusy) return;
    const version = ++sourceRevision.current;
    setSourceBusy(true);
    setSourceError("");
    try {
      if (typeof job.Version !== "number" || !Number.isSafeInteger(job.Version) || job.Version < 0) throw new Error("This job has no valid version for retrieving its original submission. Edit as JSON instead.");
      const submission = await api.submission(job.ID, job.Version);
      if (version !== sourceRevision.current) return;
      if (!submission) throw new Error("No original specification is stored for this job version. Edit as JSON instead.");
      onEdit(job, submission);
    } catch (cause) {
      if (version === sourceRevision.current) setSourceError(`Load job specification failed: ${errorMessage(cause)}`);
    } finally {
      if (version === sourceRevision.current) setSourceBusy(false);
    }
  }
  const tick = useRefreshTick();
  React.useEffect(() => {
    let current = true;
    setError("");
    void api.job(jobId).then(detail => { if (current) setJob({ api, jobId, value: detail }); })
      .catch((cause: unknown) => { if (current) setError(errorMessage(cause)); });
    void api.allocations(jobId).then(list => { if (current) setAllocations({ api, jobId, value: list }); })
      .catch((cause: unknown) => { if (current) setError(errorMessage(cause)); });
    return () => { current = false; };
  }, [api, jobId, refresh, tick]);
  const changed = () => { setRefresh(value => value + 1); onChanged(); };
  return <Card>
    <CardHeader><CardTitle className="break-words">{job?.Name ?? jobId}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      {!job ? <p className="text-sm">Loading job...</p> : <>
        <p className="text-sm text-muted-foreground">{job.Type ?? "Unknown type"} / {job.Status ?? "Unknown status"} / {job.Namespace ?? "default"} / version {job.Version ?? "unknown"}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => { sourceRevision.current++; setSourceBusy(false); setSourceError(""); onEdit(job); }}>Edit as JSON</Button>
          <Button variant="outline" disabled={sourceBusy} onClick={() => void editSpecification()}>{sourceBusy ? "Loading job specification..." : "Edit job specification"}</Button>
          <Button variant="outline" onClick={() => setRefresh(value => value + 1)}>Refresh details</Button>
          <Button variant="outline" onClick={() => onNavigate("variables", `nomad/jobs/${job.ID}`)}>Job variables</Button>
          {canManage && <ConfirmAction label="Stop job" description={`Stop ${jobId} and its allocations? History is retained.`} danger onConfirm={async () => { await api.stop(jobId); changed(); }} />}
        </div>
        {sourceError && <p role="alert" className="break-words text-sm text-destructive">{sourceError}</p>}
        <Constraints constraints={job.Constraints} />
        {(job.TaskGroups ?? []).some(group => [...(group.Services ?? []), ...(group.Tasks ?? []).flatMap(task => task.Services ?? [])].some(service => !service.Provider || service.Provider === "consul")) && <JobConsulHealth api={api} jobId={jobId} refresh={refresh} />}
        <h3 className="font-medium">Task groups</h3>
        {(job.TaskGroups ?? []).map(group => <section key={group.Name} className="space-y-3 rounded-md border border-border p-3">
          <h4 className="break-words font-medium">{group.Name}: {group.Count ?? 0} instances</h4>
          <Constraints constraints={group.Constraints} />
          <Services services={group.Services} onNavigate={onNavigate} />
          {(group.Tasks ?? []).map(task => <section key={task.Name} className="space-y-2 border-l-2 border-border pl-3">
            <p className="break-words text-sm font-medium">{task.Name} / {task.Driver ?? "unknown driver"}</p>
            <p className="text-sm">CPU {task.Resources?.CPU ?? 0} MHz / memory {task.Resources?.MemoryMB ?? 0} MiB{task.Resources?.MemoryMaxMB ? ` (max ${task.Resources.MemoryMaxMB} MiB)` : ""}</p>
            <Constraints constraints={task.Constraints} />
            <Services services={task.Services} onNavigate={onNavigate} />
            <Button variant="outline" onClick={() => onNavigate("variables", `nomad/jobs/${job.ID}/${group.Name}/${task.Name}`)}>Variables for {task.Name}</Button>
          </section>)}
          {canManage && <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">New count for {group.Name}<Input aria-label={`Count for ${group.Name}`} className="mt-1 w-28" type="number" min={0} step={1} value={counts[group.Name] ?? String(group.Count ?? 0)} onChange={event => setCounts({ ...counts, [group.Name]: event.target.value })} /></label>
            <ConfirmAction label={`Scale ${group.Name}`} description={`Change running allocation count for ${group.Name}?`} onConfirm={async () => {
              const value = counts[group.Name] ?? String(group.Count ?? 0);
              const count = Number(value);
              if (!/^\d+$/.test(value) || !Number.isSafeInteger(count)) throw new Error("Task group count must be a nonnegative safe integer.");
              await api.scale(jobId, group.Name, count); changed();
            }} />
          </div>}
        </section>)}
        <h3 className="font-medium">Allocations</h3>
        {allocations.length === 0 && <p className="text-sm text-muted-foreground">No allocations.</p>}
        <div className="space-y-2">{allocations.map(allocation => <Button key={allocation.ID} variant="outline" className="h-auto w-full justify-start whitespace-normal break-all text-left" onClick={() => onNavigate("allocations", allocation.ID)}>{allocation.Name ?? allocation.ID} / {allocation.TaskGroup} / {allocation.ClientStatus}</Button>)}</div>
        <JsonView value={job} />
        {children}
      </>}
    </CardContent>
  </Card>;
}
function Constraints({ constraints }: { constraints?: Constraint[] }) {
  if (!constraints?.length) return null;
  return <div><h4 className="text-sm font-medium">Constraints</h4><ul className="text-sm">{constraints.map((constraint, index) => <li key={index} className="break-words">{constraint.LTarget} {constraint.Operand} {constraint.RTarget}</li>)}</ul></div>;
}
function Services({ services, onNavigate }: { services?: JobService[]; onNavigate: Props["onNavigate"] }) {
  if (!services?.length) return null;
  return <div><h4 className="text-sm font-medium">Services</h4><div className="flex flex-wrap gap-2">{services.map((service, index) => {
    const label = <>{service.Name ?? "Unnamed service"} / {service.Provider ?? "consul"} / port {service.PortLabel ?? "default"}{service.Tags?.length ? ` / ${service.Tags.join(", ")}` : ""}</>;
    return service.Provider === "nomad" ? <Button key={index} variant="outline" className="h-auto whitespace-normal break-words" onClick={() => onNavigate("services", service.Name)}>{label}</Button> : <span key={index} className="rounded-md border border-border px-3 py-2 text-sm break-words">{label}</span>;
  })}</div></div>;
}
