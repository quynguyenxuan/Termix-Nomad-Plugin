import React from "react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@termix-ssh/plugin-sdk/ui";
import { errorMessage, type Format, type Job, type JobSubmission, type JobValidation, type NomadApi, type PlanResult } from "./nomad-api";
import { JsonView, type ResourceApi } from "./ResourceUI";
import { JobDiff, PlacementFailures } from "./JobOperations";
import { JobTemplates } from "./JobOperationsTemplates";
import { JobSourceEditor } from "./JobSourceEditor";

interface Props {
  api: NomadApi;
  namespace: string;
  canManage: boolean;
  initialJob?: Job;
  initialSubmission?: JobSubmission;
  onDeployed(job: Job): void;
  templateApi?: ResourceApi;
}
interface PlannedJob {
  job: Job;
  result: PlanResult;
  submission: JobSubmission;
}
const selectClass = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const maxSourceBytes = 1024 * 1024;

function download(source: string, name: string) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function readFile(file: File): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Cannot read this file as text."));
  reader.onerror = () => reject(new Error("Cannot read the selected file."));
  reader.onabort = () => reject(new Error("File reading was cancelled."));
  reader.readAsText(file);
  return promise;
}
function hasValidationErrors(result: JobValidation) {
  return Boolean(result.Error || result.ValidationErrors.length);
}

export function JobEditor({ api, namespace, canManage, initialJob, initialSubmission, templateApi, onDeployed }: Props) {
  const [source, setSource] = React.useState(() => initialSubmission?.Source ?? (initialJob ? JSON.stringify(initialJob, null, 2) : ""));
  const [format, setFormat] = React.useState<Format>(() => initialSubmission ? (initialSubmission.Format === "json" ? "json" : "hcl") : initialJob ? "json" : "hcl");
  const [variables, setVariables] = React.useState(initialSubmission?.Variables ?? "");
  const [wrap, setWrap] = React.useState(true);
  const [validation, setValidation] = React.useState<{ job: Job; result: JobValidation } | null>(null);
  const [plan, setPlan] = React.useState<PlannedJob | null>(null);
  const [busy, setBusy] = React.useState("");
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [showTemplates, setShowTemplates] = React.useState(false);
  const revision = React.useRef(0);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);

  function invalidate() {
    revision.current++;
    setPlan(null);
    setValidation(null);
    setBusy("");
    setError("");
    setMessage("");
  }
  React.useEffect(invalidate, [api, namespace]);
  const current = (version: number) => mounted.current && version === revision.current;
  const submitting = busy === "Submitting job";

  async function importFile(file: File, vars = false) {
    if (submitting) return;
    invalidate();
    const version = revision.current;
    try {
      if (file.size > maxSourceBytes) throw new Error("Files must be at most 1 MiB.");
      const value = await readFile(file);
      if (!current(version)) return;
      if (vars) setVariables(value);
      else {
        setFormat(/\.json$/i.test(file.name) || /^[\s\uFEFF]*[\[{]/.test(value) ? "json" : "hcl");
        setSource(value);
      }
    } catch (cause) {
      if (current(version)) setError(`Import ${vars ? "variables" : "job"} failed: ${errorMessage(cause)}`);
    }
  }

  async function preview(withPlan: boolean) {
    if (busy || !source.trim() || !namespace || namespace === "*") return;
    invalidate();
    const version = revision.current;
    let stage = "Source parsing";
    const submission: JobSubmission = { Source: source, Format: format === "hcl" ? "hcl2" : "json", ...(format === "hcl" ? { Variables: variables } : {}) };
    setBusy(stage);
    try {
      if (new TextEncoder().encode(source).byteLength > maxSourceBytes || (format === "hcl" && new TextEncoder().encode(variables).byteLength > maxSourceBytes)) {
        throw new Error("Job source and HCL variables must each be at most 1 MiB.");
      }
      const job = await api.parse(source, format, format === "hcl" ? variables : "");
      if (!current(version)) return;
      if (job.Namespace && job.Namespace !== namespace) throw new Error("Job namespace must match the selected namespace.");
      job.Namespace = namespace;
      stage = "Configuration validation";
      setBusy(stage);
      const result = await api.validate(job);
      if (!current(version)) return;
      setValidation({ job, result });
      if (hasValidationErrors(result) || !withPlan) return;
      stage = "Job planning";
      setBusy(stage);
      const planned = await api.plan(job);
      if (!current(version)) return;
      if (!Number.isSafeInteger(planned.JobModifyIndex) || planned.JobModifyIndex < 0) {
        throw new Error("Nomad returned an unsafe job modification index. Deployment is blocked.");
      }
      setPlan({ job, result: planned, submission });
    } catch (cause) {
      if (current(version)) setError(`${stage} failed: ${errorMessage(cause)}`);
    } finally {
      if (current(version)) setBusy("");
    }
  }
  async function deploy() {
    if (!plan || !canManage || busy) return;
    const planned = plan;
    const version = revision.current;
    setPlan(null);
    setBusy("Submitting job");
    setError("");
    try {
      await api.deploy(planned.job, planned.result.JobModifyIndex, planned.submission);
      if (!current(version)) return;
      setMessage(`Submitted job ${planned.job.ID}.`);
      onDeployed(planned.job);
    } catch (cause) {
      if (current(version)) setError(`Job submission failed: ${errorMessage(cause)} Plan again before retrying deployment.`);
    } finally {
      if (current(version)) setBusy("");
    }
  }
  const fileInput = (vars = false) => <label className="text-sm">{vars ? "Import HCL variables" : "Import job file"}<input aria-label={vars ? "Import HCL variables" : "Import job file"} className="ml-2 max-w-full text-sm" type="file" accept={vars ? ".hcl,.nomadvars,.tfvars" : ".nomad,.hcl,.json"} disabled={submitting} onChange={event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void importFile(file, vars);
  }} /></label>;

  return <Card>
    <CardHeader><CardTitle>Job editor</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p className="text-sm text-muted-foreground">Edit the complete Nomad configuration. Validate and review a scheduler dry run before explicitly submitting. Source and variables stay in this editor until submitted; they are not saved in browser storage.</p>
      {format === "hcl" && namespace !== "default" && <p className="text-sm text-muted-foreground">Include namespace = {JSON.stringify(namespace)} in the HCL job block. Job namespace and region must match the selected namespace and configured host region.</p>}
      {templateApi && <><Button variant="outline" disabled={submitting} onClick={() => setShowTemplates(value => !value)}>{showTemplates ? "Hide job templates" : "Choose or save job template"}</Button>{showTemplates && !submitting && <JobTemplates key={namespace} api={templateApi} source={source} format={format} canManage={canManage && namespace !== "*"} onLoad={template => { invalidate(); setFormat("hcl"); setSource(template); }} />}</>}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">Format
          <select aria-label="Job format" className={selectClass} value={format} disabled={submitting} onChange={event => { invalidate(); setFormat(event.target.value as Format); }}><option value="hcl">HCL</option><option value="json">JSON</option></select>
        </label>
        <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} />Word wrap</label>
        <Button variant="outline" disabled={!source} onClick={() => download(source, `job${format === "json" ? ".json" : ".nomad.hcl"}`)}>Export job source</Button>
        {fileInput()}
      </div>
      <div className="space-y-2" onDragOverCapture={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDropCapture={event => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        if (submitting) return;
        if (event.dataTransfer.files.length !== 1) { invalidate(); setError("Import job failed: Drop one job file at a time."); return; }
        void importFile(event.dataTransfer.files[0]);
      }}>
        <p className="text-xs text-muted-foreground">Drop a .nomad, .hcl or .json file here (maximum 1 MiB).</p>
        <JobSourceEditor label="Job source" value={source} format={format} wrap={wrap} readOnly={submitting} onChange={value => { invalidate(); setSource(value); }} />
      </div>
      {format === "hcl" && <section aria-label="HCL variables" className="space-y-2">
        <h3 className="text-sm font-medium">HCL variable values</h3>
        <p className="text-xs text-muted-foreground">Supply values for variable blocks, for example image = "nginx:stable". Values are included with the stored job submission and may contain secrets.</p>
        <JobSourceEditor label="HCL variable values" value={variables} format="hcl" wrap={wrap} readOnly={submitting} onChange={value => { invalidate(); setVariables(value); }} />
        <div className="flex flex-wrap items-center gap-3">{fileInput(true)}<Button variant="outline" disabled={!variables} onClick={() => download(variables, "job.nomadvars.hcl")}>Export HCL variables</Button></div>
      </section>}
      {error && <pre role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">{error}</pre>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {busy && <p role="status" className="text-sm">{busy}...</p>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void preview(false)} disabled={Boolean(busy) || !source.trim() || !namespace || namespace === "*"}>Validate job</Button><Button onClick={() => void preview(true)} disabled={Boolean(busy) || !source.trim() || !namespace || namespace === "*"}>Plan job</Button></div>
      {validation && <section aria-label="Job validation" className="space-y-2 rounded-md border border-border p-3">
        <h3 className="font-medium">Validation result</h3>
        <p className="text-sm">Source syntax parsed successfully. {hasValidationErrors(validation.result) ? "Configuration validation failed." : "Nomad configuration validation passed."}</p>
        {validation.result.Error && <pre role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">{validation.result.Error}</pre>}
        {validation.result.ValidationErrors.length > 0 && <ul role="alert" className="list-inside list-disc text-sm text-destructive">{validation.result.ValidationErrors.map((value, index) => <li key={index} className="whitespace-pre-wrap break-words">{value}</li>)}</ul>}
        <p className="text-sm">{validation.result.DriverConfigValidated ? "Driver configuration was validated." : "Driver configuration was not validated by this server. Planning and runtime checks may still fail."}</p>
        {validation.result.Warnings && <pre className="whitespace-pre-wrap break-words text-sm">Validation warnings: {validation.result.Warnings}</pre>}
        <details><summary className="cursor-pointer text-sm">Full canonical job configuration</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(validation.job, null, 2)}</pre></details>
        <Button variant="outline" onClick={() => download(JSON.stringify(validation.job, null, 2), "job.canonical.json")}>Export canonical JSON</Button>
      </section>}
      {plan && <section aria-label="Job plan" className="space-y-3 rounded-md border border-border p-3">
        <p className="break-words text-sm">Plan for <strong>{plan.job.ID}</strong> in {namespace}. Modification index: {plan.result.JobModifyIndex}. This dry run has not registered the job.</p>
        <h3 className="font-medium">Diff</h3><JobDiff value={plan.result.Diff} />
        <h3 className="font-medium">Scheduler dry run</h3>
        {plan.result.Annotations?.DesiredTGUpdates && <JsonView value={plan.result.Annotations.DesiredTGUpdates} />}
        {plan.job.Periodic?.Enabled === true && plan.result.NextPeriodicLaunch && <p className="text-sm">Next periodic launch: {plan.result.NextPeriodicLaunch}</p>}
        <h3 className="font-medium">Placement failures</h3><PlacementFailures value={plan.result.FailedTGAllocs} />
        {plan.result.Warnings != null && <pre className="whitespace-pre-wrap break-words text-sm">Plan warnings: {String(plan.result.Warnings)}</pre>}
        <h3 className="font-medium">Preemptions</h3>
        {plan.result.Annotations?.PreemptedAllocs?.length ? <><p className="text-sm">The scheduler would preempt these allocations:</p><ul className="text-sm">{plan.result.Annotations.PreemptedAllocs.map((allocation, index) => <li className="break-words" key={allocation.ID ?? index}>{allocation.Name ?? allocation.ID} / allocation {allocation.ID} / node {allocation.NodeID ?? "unknown"}</li>)}</ul><JsonView value={plan.result.Annotations.PreemptedAllocs} /></> : <p className="text-sm">No preempted allocations reported by the scheduler.</p>}
        <JsonView value={plan.result} />
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setPlan(null)}>Back to editor</Button><Button disabled={!canManage || Boolean(busy)} onClick={() => void deploy()}>Deploy planned job</Button></div>
        {!canManage && <p className="text-sm text-muted-foreground">Manage permission is required to deploy.</p>}
      </section>}
    </CardContent>
  </Card>;
}
