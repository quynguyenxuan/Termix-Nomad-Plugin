import React from "react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@termix-ssh/plugin-sdk/ui";
import { ConfirmAction, ErrorMessage, JsonView, ResourceBrowser, useRefreshTick, useResourceApi, type PageProps } from "./ResourceUI";
import { useNomadApi, errorMessage, type Job, type JobSubmission } from "./nomad-api";
import { JobDetail } from "./JobDetail";
import { JobEditor } from "./JobEditor";
import { JobOperations, PlacementFailures } from "./JobOperations";

interface Row extends Record<string, unknown> {
  ID?: string; JobID?: string; Namespace?: string; Status?: string; DeploymentID?: string; NodeID?: string;
  QueuedAllocations?: Record<string, number> | null;
}
export function JobsPage(props: PageProps) {
  const { hostId, namespace, selectedId, onNavigate: navigateTo, canManage } = props;
  const api = useResourceApi(hostId, namespace);
  const [detailNamespace, setDetailNamespace] = React.useState(namespace);
  const concreteNamespace = namespace === "*" ? detailNamespace : namespace;
  const detailApi = useResourceApi(hostId, concreteNamespace);
  const onNavigate: PageProps["onNavigate"] = (resource, id, ns = concreteNamespace) => navigateTo(resource, id, ns);
  const jobApi = useNomadApi(hostId, concreteNamespace);
  const [editor, setEditor] = React.useState<{ job?: Job; submission?: JobSubmission; revision: number } | null>(null);
  const [refresh, setRefresh] = React.useState(0);
  React.useEffect(() => { setDetailNamespace(namespace); }, [hostId, namespace]);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-semibold">Jobs</h2><Button disabled={namespace === "*"} onClick={() => setEditor({ revision: Date.now() })}>Run job</Button></div>
    {namespace === "*" && <p className="text-sm text-muted-foreground">Select a concrete namespace to create jobs. Selecting a row uses that job's namespace.</p>}
    <ResourceBrowser key={`${namespace}-${refresh}`} api={api} endpoint="/job-list" title="Jobs" selectedId={selectedId} columns={[{ key: "ID", title: "Job" }, { key: "Namespace", title: "Namespace" }, { key: "Type", title: "Type" }, { key: "Status", title: "Status" }]} onSelect={row => { setDetailNamespace(String(row.Namespace)); setEditor(null); onNavigate("jobs", String(row.ID), String(row.Namespace)); }} />
    {editor && <><Button variant="outline" onClick={() => setEditor(null)}>Close editor</Button><JobEditor key={editor.revision} api={jobApi} namespace={concreteNamespace} canManage={canManage} initialJob={editor.job} initialSubmission={editor.submission} templateApi={detailApi} onDeployed={job => { setRefresh(value => value + 1); onNavigate("jobs", job.ID); }} /></>}
    {selectedId && concreteNamespace !== "*" && <JobDetail key={`${hostId}-${concreteNamespace}-${selectedId}`} api={jobApi} jobId={selectedId} canManage={canManage} onEdit={(job, submission) => setEditor({ job, submission, revision: Date.now() })} onChanged={() => setRefresh(value => value + 1)} onNavigate={onNavigate}><JobOperations api={detailApi} jobId={selectedId} canManage={canManage} onNavigate={onNavigate} onChanged={() => setRefresh(value => value + 1)} /></JobDetail>}
    {selectedId && concreteNamespace === "*" && <p role="alert">Select this job from the list or choose its concrete namespace to view details.</p>}
  </div>;
}

export function DeploymentsPage(props: PageProps) { return <SchedulerPage {...props} kind="deployments" />; }
export function EvaluationsPage(props: PageProps) { return <SchedulerPage {...props} kind="evaluations" />; }

function SchedulerPage({ hostId, namespace, selectedId, onNavigate: navigateTo, canManage, kind }: PageProps & { kind: "deployments" | "evaluations" }) {
  const api = useResourceApi(hostId, namespace);
  const [detailNamespace, setDetailNamespace] = React.useState(namespace);
  const concreteNamespace = namespace === "*" ? detailNamespace : namespace;
  const detailApi = useResourceApi(hostId, concreteNamespace);
  const [detail, setDetail] = React.useState<Row | null>(null);
  const [allocations, setAllocations] = React.useState<Row[]>([]);
  const onNavigate: PageProps["onNavigate"] = (resource, id, ns = concreteNamespace) => navigateTo(resource, id, ns);
  const [error, setError] = React.useState("");
  const [allocationError, setAllocationError] = React.useState("");
  const [groups, setGroups] = React.useState<string[]>([]);
  const [refresh, setRefresh] = React.useState(0);
  const tick = useRefreshTick();
  React.useEffect(() => { setDetailNamespace(namespace); }, [hostId, namespace]);
  React.useEffect(() => { setDetail(null); setAllocations([]); setGroups([]); }, [selectedId, kind, hostId, concreteNamespace]);
  React.useEffect(() => {
    if (!selectedId || concreteNamespace === "*") return;
    let active = true;
    const path = `/${kind}/${encodeURIComponent(selectedId)}`;
    void detailApi.get<Row>(path).then(value => { if (active) { setDetail(value); setError(""); } }).catch(cause => { if (active) setError(errorMessage(cause)); });
    void detailApi.get<Row[]>(`${path}/allocations`).then(value => { if (active) { setAllocations(value); setAllocationError(""); } }).catch(cause => { if (active) setAllocationError(errorMessage(cause)); });
    return () => { active = false; };
  }, [detailApi, selectedId, kind, refresh, tick, concreteNamespace]);
  const title = kind === "deployments" ? "Deployments" : "Evaluations";
  const taskGroups = detail?.TaskGroups && typeof detail.TaskGroups === "object" ? Object.entries(detail.TaskGroups as Record<string, Row>) : [];
  return <div className="space-y-4">
    <h2 className="text-xl font-semibold">{title}</h2>
    <ResourceBrowser key={`${kind}-${refresh}`} api={api} endpoint={`/${kind}`} title={title} selectedId={selectedId} columns={[{ key: "ID", title: "ID" }, { key: "Namespace", title: "Namespace" }, { key: "JobID", title: "Job" }, { key: "Status", title: "Status" }, { key: kind === "deployments" ? "JobVersion" : "TriggeredBy", title: kind === "deployments" ? "Version" : "Trigger" }]} onSelect={row => { setDetailNamespace(String(row.Namespace)); onNavigate(kind, String(row.ID), String(row.Namespace)); }} />
    <ErrorMessage error={error} />
    {selectedId && concreteNamespace === "*" && <p role="alert">Choose a concrete namespace or select a row to view details.</p>}
    {selectedId && !detail && concreteNamespace !== "*" && !error && <p>Loading details...</p>}
    {detail && <Card><CardHeader><CardTitle className="break-all">{kind === "deployments" ? "Deployment" : "Evaluation"} {String(detail.ID)}</CardTitle></CardHeader><CardContent className="space-y-4">
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">{["Namespace", "Status", "StatusDescription", "JobVersion", "Priority", "Type", "TriggeredBy", "WaitUntil", "QuotaLimitReached"].filter(key => detail[key] !== undefined && detail[key] !== "").map(key => <div key={key}><dt className="text-muted-foreground">{key.replace(/([A-Z])/g, " $1").trim()}</dt><dd className="break-words">{String(detail[key])}</dd></div>)}</dl>
      <div className="flex flex-wrap gap-2">{detail.JobID && <Button variant="outline" onClick={() => onNavigate("jobs", String(detail.JobID))}>Job {String(detail.JobID)}</Button>}{detail.DeploymentID && <Button variant="outline" onClick={() => onNavigate("deployments", String(detail.DeploymentID))}>Deployment {String(detail.DeploymentID)}</Button>}{detail.NodeID && <Button variant="outline" onClick={() => onNavigate("nodes", String(detail.NodeID))}>Node {String(detail.NodeID)}</Button>}{["NextEval", "PreviousEval", "BlockedEval"].map(key => detail[key] ? <Button key={key} variant="outline" onClick={() => onNavigate("evaluations", String(detail[key]))}>{key}: {String(detail[key])}</Button> : null)}</div>
      {kind === "deployments" && <section className="space-y-3"><h3 className="font-medium">Task group rollout</h3>{taskGroups.map(([name, group]) => <section key={name} className="space-y-2 rounded border border-border p-3"><h4 className="font-medium">{name}</h4><dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">{["DesiredTotal", "PlacedAllocs", "HealthyAllocs", "UnhealthyAllocs", "DesiredCanaries", "Promoted", "AutoRevert", "AutoPromote"].map(key => <div key={key}><dt className="text-muted-foreground">{key.replace(/([A-Z])/g, " $1").trim()}</dt><dd>{String(group[key] ?? "-")}</dd></div>)}</dl>{Array.isArray(group.PlacedCanaries) && <div className="flex flex-wrap gap-2">{group.PlacedCanaries.map(id => <Button key={String(id)} variant="outline" onClick={() => onNavigate("allocations", String(id))}>Canary {String(id)}</Button>)}</div>}</section>)}
        {canManage && <><fieldset className="space-y-2"><legend className="text-sm">Promote specific groups (none selected promotes all)</legend>{taskGroups.map(([name]) => <label key={name} className="mr-3 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={groups.includes(name)} onChange={event => setGroups(previous => event.target.checked ? [...previous, name] : previous.filter(value => value !== name))} />{name}</label>)}</fieldset><div className="flex flex-wrap gap-2">{["promote", "fail", "pause", "resume", "unblock"].map(action => <ConfirmAction key={action} label={`${action[0].toUpperCase()}${action.slice(1)} deployment`} description={`${action} deployment ${selectedId}? This changes its rollout.`} danger={action === "fail"} onConfirm={async () => { await detailApi.post(`/deployments/${encodeURIComponent(selectedId!)}/${action}`, action === "promote" ? { groups } : {}); setRefresh(value => value + 1); }} />)}</div></>}
      </section>}
      {kind === "evaluations" && <>
        <section className="space-y-2"><h3 className="font-medium">Placement failures</h3><PlacementFailures value={detail.FailedTGAllocs} /></section>
        {detail.QueuedAllocations && typeof detail.QueuedAllocations === "object" && <section><h3 className="font-medium">Queued allocations</h3><ul className="text-sm">{Object.entries(detail.QueuedAllocations as Row).map(([name, count]) => <li key={name}>{name}: {String(count)}</li>)}</ul></section>}
        {Array.isArray(detail.RelatedEvals) && <section className="space-y-2"><h3 className="font-medium">Related evaluations</h3>{(detail.RelatedEvals as Row[]).map(evaluation => <Button key={String(evaluation.ID)} variant="outline" onClick={() => onNavigate("evaluations", String(evaluation.ID))}>{String(evaluation.ID)} / {String(evaluation.Status)}</Button>)}</section>}
      </>}
      <section className="space-y-2"><h3 className="font-medium">Allocations</h3><ErrorMessage error={allocationError} />{!allocations.length && !allocationError && <p className="text-sm">No allocations.</p>}{allocations.map(allocation => <Button key={String(allocation.ID)} variant="outline" className="h-auto whitespace-normal break-all" onClick={() => onNavigate("allocations", String(allocation.ID))}>{String(allocation.Name ?? allocation.ID)} / {String(allocation.ClientStatus)}</Button>)}</section>
      <JsonView value={detail} />
    </CardContent></Card>}
  </div>;
}
