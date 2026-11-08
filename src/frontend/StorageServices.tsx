import React from "react";
import { Button } from "@termix-ssh/plugin-sdk/ui";
import { ConfirmAction, ErrorMessage, JsonView, ResourceBrowser, useResourceApi, type PageProps } from "./ResourceUI";
import { Fields, StorageTable, records, text, useStorageDetail, type RecordValue, type StorageApi } from "./StorageCommon";

function ServiceChecks({ api, name, registration }: { api: StorageApi; name: string; registration: RecordValue }) {
  const [opened, setOpened] = React.useState(false);
  const checks = useStorageDetail<RecordValue>(api, opened ? `/services/${encodeURIComponent(name)}/${encodeURIComponent(text(registration.ID))}/checks` : "");
  const rows = records(Object.values(checks.value ?? {})).filter(check => check.Service === name || check.ServiceName === name);
  return <section className="space-y-2"><Button variant="outline" onClick={() => setOpened(!opened)}>{opened ? "Hide health checks" : "Load health checks"}</Button>{opened && <><ErrorMessage error={checks.error} />{checks.value && <><StorageTable rows={rows} columns={["Check", "Status", "Output", "Task", "Timestamp"]} /><p className="text-xs text-muted-foreground">Native Nomad allocation checks only; Consul-managed checks are not available through this API.</p><JsonView value={checks.value} /></>}{!checks.value && !checks.error && <p role="status">Loading checks...</p>}</>}</section>;
}
function ServiceDetail({ api, name, props }: { api: StorageApi; name: string; props: PageProps }) {
  const detail = useStorageDetail<RecordValue[]>(api, `/services/${encodeURIComponent(name)}`);
  return <section className="space-y-3" aria-label="Service registrations"><h3 className="break-words font-semibold">{name} registrations</h3><ErrorMessage error={detail.error} />{detail.value && !detail.value.length && <p>No registrations.</p>}{detail.value?.map(registration => <article className="space-y-3 rounded-md border p-4" key={text(registration.ID)}>
    <Fields value={registration} names={["ID", "Address", "Port", "Namespace", "Datacenter", "Tags"]} />
    <div className="flex flex-wrap gap-2">{[["jobs", "JobID"], ["allocations", "AllocID"], ["nodes", "NodeID"]].map(([resource, field]) => registration[field] ? <Button variant="outline" key={field} onClick={() => props.onNavigate(resource, text(registration[field]), props.namespace)}>{field}: {text(registration[field])}</Button> : null)}</div>
    <ServiceChecks api={api} name={name} registration={registration} />
    <ConfirmAction label="Deregister instance" description={`Remove registration ${text(registration.ID)}? A running allocation may register it again.`} danger disabled={!props.canManage} onConfirm={async () => { await api.del(`/services/${encodeURIComponent(name)}/${encodeURIComponent(text(registration.ID))}`); detail.refresh(); }} />
    <JsonView value={registration} />
  </article>)}{!detail.value && !detail.error && <p role="status">Loading registrations...</p>}</section>;
}
export function ServicesContent(props: PageProps) {
  const api = useResourceApi(props.hostId, props.namespace);
  return <div className="space-y-4"><h2 className="text-lg font-semibold">Services</h2><p className="text-sm text-muted-foreground">Native Nomad service discovery, instance addresses, allocation health checks and explicit deregistration.</p>
    <ResourceBrowser api={api} endpoint="/services" title="Registered services" selectedId={props.selectedId} columns={[{ key: "ServiceName", title: "Service" }, { key: "Namespace", title: "Namespace" }, { key: "Tags", title: "Tags", render: row => text(row.Tags) }]} onSelect={row => props.onNavigate("services", text(row.ServiceName), text(row.Namespace))} />
    {props.selectedId && props.namespace === "*" && <p role="status">Select a concrete namespace to inspect registrations.</p>}
    {props.selectedId && props.namespace !== "*" && <ServiceDetail key={`${props.hostId}:${props.namespace}:${props.selectedId}`} api={api} name={props.selectedId} props={props} />}
  </div>;
}
