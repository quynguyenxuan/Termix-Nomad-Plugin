import React from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@termix-ssh/plugin-sdk/ui";
import { ConfirmAction, ErrorMessage, JsonView, ResourceBrowser, useRefreshTick, useResourceApi, type PageProps } from "./ResourceUI";
import { AdminEditor, adminTitles, type AdminKind, type AdminValue } from "./AdminForms";

const identity: Record<AdminKind, string> = { namespaces: "Name", policies: "Name", roles: "ID", tokens: "AccessorID", "auth-methods": "Name", "binding-rules": "ID", sentinel: "Name" };
const endpoint = (kind: AdminKind, id?: string) => `/administration/${kind}${id ? `/${encodeURIComponent(id)}` : ""}`;

export function AdministrationPage(props: PageProps) {
  if (!props.canAdmin) return <p role="alert" className="p-4 text-sm">Administration permission is required to view or change namespaces, ACLs and policies.</p>;
  return <AdminResources key={`${props.hostId}:${props.namespace}`} {...props} />;
}

function AdminResources({ hostId, namespace }: PageProps) {
  const api = useResourceApi(hostId, namespace);
  const tick = useRefreshTick();
  const [kind, setKind] = React.useState<AdminKind>("namespaces");
  const [selected, setSelected] = React.useState("");
  const [detail, setDetail] = React.useState<AdminValue | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [revision, setRevision] = React.useState(0);
  const [message, setMessage] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [cloneName, setCloneName] = React.useState("");
  const [cloneTTL, setCloneTTL] = React.useState("");
  const epoch = React.useRef(0);
  React.useEffect(() => () => { epoch.current += 1; }, []);
  React.useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let active = true;
    setError(null);
    api.get<AdminValue>(endpoint(kind, selected)).then(value => { if (active) setDetail(value); }).catch(cause => { if (active) setError(cause); });
    return () => { active = false; };
  }, [api, kind, selected, tick]);
  function changeKind(next: AdminKind) {
    if (next === kind) return;
    epoch.current += 1;
    setKind(next); setSelected(""); setCreating(false); setDetail(null); setError(null); setMessage(""); setSecret("");
  }
  function select(row: AdminValue) {
    const value = row[identity[kind]];
    if (typeof value !== "string" || !value || value === selected) return;
    epoch.current += 1;
    setDetail(null); setSelected(value); setCreating(false); setError(null); setSecret(""); setCloneName(`${String(row.Name ?? "token")} copy`); setCloneTTL(""); setMessage("");
  }
  function tokenResult(result: unknown) {
    if (!result || typeof result !== "object") return;
    const value = result as AdminValue;
    if (typeof value.secret === "string") setSecret(value.secret);
    if (typeof value.secretUnavailable === "string") setMessage(value.secretUnavailable);
  }
  async function save(body: AdminValue) {
    const current = epoch.current;
    setSecret("");
    const result = selected && !creating ? await api.put(endpoint(kind, selected), body) : await api.post(endpoint(kind), body);
    if (current !== epoch.current) return;
    setSelected(""); setCreating(false); setDetail(null); setMessage("Saved successfully."); setRevision(value => value + 1);
    if (kind === "tokens") tokenResult(result);
  }
  async function tokenAction(path: string, body?: AdminValue, refresh = false) {
    const current = epoch.current;
    setSecret("");
    const result = await api.post(path, body);
    if (current !== epoch.current) return;
    tokenResult(result);
    if (refresh) setRevision(value => value + 1);
  }
  const columns = kind === "tokens" ? [{ key: "Name", title: "Name" }, { key: "AccessorID", title: "Accessor ID" }, { key: "Type", title: "Type" }, { key: "ExpirationTime", title: "Expires" }]
    : kind === "binding-rules" ? [{ key: "ID", title: "ID" }, { key: "AuthMethod", title: "Authentication method" }, { key: "BindType", title: "Binding type" }, { key: "BindName", title: "Target" }]
    : kind === "auth-methods" ? [{ key: "Name", title: "Name" }, { key: "Type", title: "Type" }, { key: "TokenLocality", title: "Token locality" }, { key: "Default", title: "Default" }]
    : [{ key: "Name", title: "Name" }, { key: "Description", title: "Description" }, ...(kind === "sentinel" ? [{ key: "Scope", title: "Scope" }, { key: "EnforcementLevel", title: "Enforcement" }] : [])];
  return <div className="min-w-0 space-y-4">
    <Card><CardHeader><CardTitle>Administration</CardTitle></CardHeader><CardContent className="space-y-3">
      <p className="text-sm text-muted-foreground">These are cluster-level resources. All reads and changes require administration permission. Changes never bootstrap ACLs or replace this host's connection token.</p>
      <nav aria-label="Administration resources" className="flex flex-wrap gap-2">{(Object.keys(adminTitles) as AdminKind[]).map(value => <Button key={value} variant={kind === value ? "default" : "outline"} aria-pressed={kind === value} onClick={() => changeKind(value)}>{adminTitles[value]}</Button>)}</nav>
      <div className="flex flex-wrap gap-2"><Button onClick={() => { epoch.current += 1; setSelected(""); setDetail(null); setCreating(true); setError(null); setSecret(""); setMessage(""); }}>Create {adminTitles[kind]}</Button>{(selected || creating) && <Button variant="outline" onClick={() => { epoch.current += 1; setSelected(""); setCreating(false); setDetail(null); setSecret(""); }}>Close editor</Button>}</div>
      {kind === "tokens" && <p className="text-sm text-muted-foreground">Lists and editors never contain token secrets. New or explicitly revealed secrets are held only in this view until hidden or navigation. The configured connection credential cannot be revealed.</p>}
      {kind === "sentinel" && <p className="text-sm text-muted-foreground">Sentinel requires Nomad Enterprise support; an unsupported edition or denied ACL is shown as an error, not an empty success.</p>}
    </CardContent></Card>
    {message && <p role="status" className="text-sm">{message}</p>}
    {secret && <section aria-label="Token secret" className="space-y-2 rounded-md border border-border p-4">
      <h3 className="font-semibold">Token secret - store securely</h3><p className="text-sm">This credential grants the token's permissions. It is not saved in browser storage or host settings.</p>
      <label className="flex flex-col gap-1 text-sm">Secret ID<Input aria-label="Secret ID" value={secret} readOnly autoComplete="off" className="font-mono" /></label>
      <Button variant="outline" onClick={() => { epoch.current += 1; setSecret(""); }}>Hide secret</Button>
    </section>}
    <ResourceBrowser key={`${kind}:${revision}`} api={api} endpoint={endpoint(kind)} title={adminTitles[kind]} columns={columns} selectedId={selected} onSelect={select} />
    {error != null && <ErrorMessage error={error} />}
    {selected && !detail && !error && <p role="status">Loading resource...</p>}
    {detail && selected && <section aria-label="Administration resource details" className="space-y-4">
      <dl className="grid gap-3 rounded-md border border-border p-4 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Resource</dt><dd className="break-all font-medium">{String(detail.Name || selected)}</dd></div>
        <div><dt className="text-muted-foreground">{identity[kind]}</dt><dd className="break-all">{selected}</dd></div>
        {detail.Description != null && <div><dt className="text-muted-foreground">Description</dt><dd className="break-words">{String(detail.Description)}</dd></div>}
        {detail.ModifyIndex != null && <div><dt className="text-muted-foreground">Modify index</dt><dd>{String(detail.ModifyIndex)}</dd></div>}
      </dl>
      <AdminEditor key={`${kind}:${selected}`} kind={kind} initial={detail} editing onSave={save} />
      {kind === "tokens" && <section aria-label="Token secret and cloning" className="space-y-3 rounded-md border border-border p-4">
        <ConfirmAction label="Reveal token secret" description="Reveal this token's credential in this view? It grants access to Nomad. The host connection credential is never disclosed." onConfirm={() => tokenAction(`${endpoint(kind, selected)}/secret`)} />
        <label className="flex flex-col gap-1 text-sm">Cloned token name<Input aria-label="Cloned token name" value={cloneName} onChange={event => setCloneName(event.target.value)} /></label>
        <label className="flex flex-col gap-1 text-sm">Cloned token expiration TTL<Input aria-label="Cloned token expiration TTL" placeholder="8h (optional; otherwise no expiry)" value={cloneTTL} onChange={event => setCloneTTL(event.target.value)} /></label>
        <p className="text-sm text-muted-foreground">Clone copies type, locality, policies and role links into a new credential. Expiration is set independently; it never copies the source secret.</p>
        <ConfirmAction label="Clone token" description="Create a new token with these permissions? This does not rotate or replace any existing connection credential." disabled={!cloneName.trim()} onConfirm={() => tokenAction(`${endpoint(kind, selected)}/clone`, { Name: cloneName, ...(cloneTTL ? { ExpirationTTL: cloneTTL } : {}) }, true)} />
      </section>}
      <ConfirmAction label={`Delete ${String(detail.Name || selected)}`} description={`Permanently delete this ${adminTitles[kind]} resource? This can revoke access or affect running workloads. Nomad will reject resources that cannot be removed.`} danger onConfirm={async () => {
        const current = epoch.current;
        await api.del(endpoint(kind, selected));
        if (current !== epoch.current) return;
        setSelected(""); setDetail(null); setSecret(""); setMessage("Deleted successfully."); setRevision(value => value + 1);
      }} />
      <JsonView value={detail} />
    </section>}
    {creating && <AdminEditor key={`new:${kind}:${epoch.current}`} kind={kind} onSave={save} />}
  </div>;
}
