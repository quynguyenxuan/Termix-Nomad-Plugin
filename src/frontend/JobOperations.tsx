import React from "react";
import { Button, Input, Textarea } from "@termix-ssh/plugin-sdk/ui";
import { ConfirmAction, ErrorMessage, JsonView, useRefreshTick, type PageProps, type ResourceApi } from "./ResourceUI";
import { errorMessage, type Job } from "./nomad-api";

interface Row extends Record<string, unknown> { EvalID?: string; DispatchedJobID?: string }
interface Versions { Versions: Job[]; Diffs?: unknown[] }
interface Props { api: ResourceApi; jobId: string; canManage: boolean; onNavigate: PageProps["onNavigate"]; onChanged(): void }

export function JobOperations({ api, jobId, canManage, onNavigate, onChanged }: Props) {
  const [job, setJob] = React.useState<Job | null>(null);
  const [versions, setVersions] = React.useState<Versions | null>(null);
  const [deployments, setDeployments] = React.useState<Row[]>([]);
  const [evaluations, setEvaluations] = React.useState<Row[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [baseline, setBaseline] = React.useState("");
  const [targetVersion, setTargetVersion] = React.useState("");
  const [metadata, setMetadata] = React.useState<Record<string, string>>({});
  const [metaName, setMetaName] = React.useState("");
  const [payload, setPayload] = React.useState("");
  const [idPrefix, setIdPrefix] = React.useState("");
  const [forceReschedule, setForceReschedule] = React.useState(false);
  const [result, setResult] = React.useState<Row | null>(null);
  const [refresh, setRefresh] = React.useState(0);
  const tick = useRefreshTick();
  const path = `/jobs/${encodeURIComponent(jobId)}`;
  React.useEffect(() => {
    let active = true;
    const load = async <T,>(key: string, request: Promise<T>, apply: (value: T) => void) => {
      try { const value = await request; if (active) { apply(value); setErrors(old => ({ ...old, [key]: "" })); } }
      catch (cause) { if (active) setErrors(old => ({ ...old, [key]: errorMessage(cause) })); }
    };
    void load("job", api.get<Job>(path), setJob);
    void load("versions", api.get<Versions>(`${path}/versions`, baseline ? { diff_version: baseline } : undefined), setVersions);
    void load("deployments", api.get<Row[]>(`${path}/deployments`), setDeployments);
    void load("evaluations", api.get<Row[]>(`${path}/evaluations`), setEvaluations);
    return () => { active = false; };
  }, [api, path, baseline, refresh, tick]);
  const action = async (suffix: string, body?: unknown) => {
    const response = await api.post<Row | null>(`${path}/${suffix}`, body ?? {});
    setResult(response); setRefresh(value => value + 1); onChanged();
  };
  const required = job?.ParameterizedJob?.MetaRequired ?? [];
  const optional = job?.ParameterizedJob?.MetaOptional ?? [];
  const metaKeys = [...new Set([...required, ...optional, ...Object.keys(metadata)])];
  return <div className="space-y-5">
    <ErrorMessage error={errors.job} />
    <section className="space-y-3 border-t border-border pt-4" aria-label="Job versions">
      <h3 className="font-medium">Versions and differences</h3>
      <ErrorMessage error={errors.versions} />
      <label className="block text-sm">Compare versions against <select aria-label="Diff baseline" className="ml-2 rounded border bg-background p-2" value={baseline} onChange={event => setBaseline(event.target.value)}><option value="">Previous version</option>{versions?.Versions.map(version => <option key={version.Version} value={version.Version}>{version.Version}</option>)}</select></label>
      {versions && <>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Version</th><th>Status</th><th>Stable</th><th>Modification index</th></tr></thead><tbody>{versions.Versions.map(version => <tr key={version.Version}><td>{version.Version}</td><td>{version.Status}</td><td>{String(version.Stable ?? false)}</td><td>{String(version.JobModifyIndex ?? "")}</td></tr>)}</tbody></table></div>
        {!versions.Versions.length && <p className="text-sm">No retained versions.</p>}
        {(versions.Diffs ?? []).map((diff, index) => <JobDiff key={index} value={diff} />)}
        {canManage && versions.Versions.length > 0 && <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">Revert to version <select aria-label="Revert version" className="ml-2 rounded border bg-background p-2" value={targetVersion} onChange={event => setTargetVersion(event.target.value)}><option value="">Choose version</option>{versions.Versions.map(version => <option key={version.Version} value={version.Version}>{version.Version}</option>)}</select></label>
          <ConfirmAction label="Revert job" description={`Deploy version ${targetVersion} of ${jobId}? Revert is guarded against a changed current version.`} disabled={!targetVersion || job?.Version === undefined} onConfirm={() => action("revert", { version: Number(targetVersion), enforcePriorVersion: job?.Version })} />
        </div>}
      </>}
    </section>
    <section className="space-y-2" aria-label="Job deployments"><h3 className="font-medium">Deployments</h3><ErrorMessage error={errors.deployments} />{!deployments.length && !errors.deployments && <p className="text-sm">No deployments.</p>}{deployments.map(deployment => <Button key={String(deployment.ID)} variant="outline" className="h-auto whitespace-normal break-all" onClick={() => onNavigate("deployments", String(deployment.ID))}>{String(deployment.ID)} / {String(deployment.Status)} / version {String(deployment.JobVersion)}</Button>)}</section>
    <section className="space-y-2" aria-label="Job evaluations"><h3 className="font-medium">Evaluations</h3><ErrorMessage error={errors.evaluations} />{!evaluations.length && !errors.evaluations && <p className="text-sm">No evaluations.</p>}{evaluations.map(evaluation => <Button key={String(evaluation.ID)} variant="outline" className="h-auto whitespace-normal break-all" onClick={() => onNavigate("evaluations", String(evaluation.ID))}>{String(evaluation.ID)} / {String(evaluation.Status)} / {String(evaluation.TriggeredBy)}</Button>)}</section>
    {canManage && job && <section className="space-y-3 border-t border-border pt-4" aria-label="Job lifecycle actions">
      <h3 className="font-medium">Lifecycle actions</h3>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={forceReschedule} onChange={event => setForceReschedule(event.target.checked)} />Force reschedule failed allocations</label>
      <div className="flex flex-wrap gap-2"><ConfirmAction label="Evaluate job" description="Schedule a fresh evaluation of this job?" onConfirm={() => action("evaluate", { forceReschedule })} />{job.Periodic && <ConfirmAction label="Force periodic run" description="Immediately launch a new periodic instance?" onConfirm={() => action("periodic-force")} />}</div>
      {job.Periodic && <p className="text-sm">Periodic schedule: {String(job.Periodic.Spec ?? (Array.isArray(job.Periodic.Specs) ? job.Periodic.Specs.join(", ") : ""))} / {String(job.Periodic.TimeZone ?? "UTC")}</p>}
      {job.ParameterizedJob && <section className="space-y-3 rounded border border-border p-3" aria-label="Dispatch parameterized job"><h4 className="font-medium">Dispatch parameterized job</h4>
        <p className="text-sm">Payload policy: {job.ParameterizedJob.Payload ?? "optional"}. Payload is UTF-8 text (up to 16 KiB).</p>
        {metaKeys.map(key => <label key={key} className="block text-sm">Metadata: {key}{required.includes(key) ? " (required)" : ""}<Input aria-label={`Metadata ${key}`} value={metadata[key] ?? ""} onChange={event => setMetadata({ ...metadata, [key]: event.target.value })} /></label>)}
        <div className="flex flex-wrap items-end gap-2"><label className="text-sm">Additional metadata key<Input value={metaName} onChange={event => setMetaName(event.target.value)} /></label><Button variant="outline" disabled={!metaName.trim()} onClick={() => { setMetadata({ ...metadata, [metaName]: "" }); setMetaName(""); }}>Add metadata</Button></div>
        <label className="block text-sm">Dispatch ID prefix<Input value={idPrefix} onChange={event => setIdPrefix(event.target.value)} /></label>
        <label className="block text-sm">Dispatch payload<Textarea aria-label="Dispatch payload" rows={5} value={payload} onChange={event => setPayload(event.target.value)} /></label>
        <ConfirmAction label="Dispatch job" description="Create and run a new child job with this metadata and payload?" onConfirm={() => {
          if (required.some(key => !metadata[key])) return Promise.reject(new Error("Fill every required metadata value."));
          return action("dispatch", { meta: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== "")), payload, idPrefix });
        }} />
      </section>}
      <ConfirmAction label="Purge job" danger description={`Permanently purge ${jobId}, its retained job history and allocations? This cannot be undone.`} onConfirm={() => action("purge")} />
    </section>}
    {result && <section aria-label="Operation result" className="space-y-2"><h3 className="font-medium">Operation submitted</h3>{result.EvalID && <Button variant="outline" onClick={() => onNavigate("evaluations", String(result.EvalID))}>Evaluation {String(result.EvalID)}</Button>}{result.DispatchedJobID && <Button variant="outline" onClick={() => onNavigate("jobs", String(result.DispatchedJobID))}>Child job {String(result.DispatchedJobID)}</Button>}<JsonView value={result} /></section>}
  </div>;
}

export function JobDiff({ value }: { value: unknown }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const diff = value as Row;
  const fields = Array.isArray(diff.Fields) ? diff.Fields as Row[] : [];
  return <section className="space-y-2 rounded border border-border p-3">
    <h4 className="break-words text-sm font-medium">{String(diff.Name ?? diff.ID ?? "Job changes")} {String(diff.Type ?? "")}</h4>
    {fields.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>{fields.map((field, index) => <tr key={index}><td className="break-words">{String(field.Name)}</td><td className="break-words">{String(field.Old ?? "")}</td><td className="break-words">{String(field.New ?? "")}</td></tr>)}</tbody></table></div>}
    {["Objects", "TaskGroups", "Tasks"].map(key => Array.isArray(diff[key]) ? (diff[key] as unknown[]).map((child, index) => <JobDiff key={`${key}-${index}`} value={child} />) : null)}
    <JsonView value={value} />
  </section>;
}

export function PlacementFailures({ value }: { value: unknown }) {
  const groups = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Row) : [];
  if (!groups.length) return <p className="text-sm">No recorded placement failures.</p>;
  return <div className="space-y-2">{groups.map(([name, value]) => {
    const metric: Row = value && typeof value === "object" ? value as Row : {};
    return <section key={name} className="space-y-2 rounded border border-border p-3"><h4 className="font-medium">{name}</h4>
      <p className="text-sm">Nodes evaluated: {String(metric.NodesEvaluated ?? 0)} / exhausted: {String(metric.NodesExhausted ?? 0)} / filtered: {String(metric.NodesFiltered ?? 0)}</p>
      {metric.NodePool !== undefined && <p className="text-sm">Pool: {String(metric.NodePool)} / nodes in pool: {String(metric.NodesInPool ?? 0)}</p>}
      {["NodesAvailable", "ConstraintFiltered", "DimensionExhausted", "ClassFiltered", "ClassExhausted"].map(key => metric[key] !== null && typeof metric[key] === "object" ? <div key={key}><h5 className="text-xs font-medium">{key.replace(/([A-Z])/g, " $1").trim()}</h5><ul className="text-sm">{Object.entries(metric[key] as Row).map(([reason, count]) => <li key={reason} className="break-words">{reason}: {String(count)}</li>)}</ul></div> : null)}
      {Array.isArray(metric.QuotaExhausted) && <p className="text-sm">Exhausted quotas: {metric.QuotaExhausted.map(String).join(", ")}</p>}
      <JsonView value={metric} />
    </section>;
  })}</div>;
}
