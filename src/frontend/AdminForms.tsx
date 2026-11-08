import React from "react";
import { Input, Textarea } from "@termix-ssh/plugin-sdk/ui";
import { ConfirmAction } from "./ResourceUI";

export type AdminKind = "namespaces" | "policies" | "roles" | "tokens" | "auth-methods" | "binding-rules" | "sentinel";
export type AdminValue = Record<string, unknown>;
export const adminTitles: Record<AdminKind, string> = {
  namespaces: "Namespaces", policies: "ACL policies", roles: "ACL roles", tokens: "ACL tokens", "auth-methods": "Authentication methods", "binding-rules": "Binding rules", sentinel: "Sentinel policies",
};
const control = "w-full rounded-md border border-input bg-background p-2 text-sm";
const asObject = (value: unknown): AdminValue => value && typeof value === "object" && !Array.isArray(value) ? value as AdminValue : {};
const split = (value: string): string[] => value.split(/[\n,]/).map(part => part.trim()).filter(Boolean);
const join = (value: unknown): string => Array.isArray(value) ? value.map(String).join("\n") : "";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1 text-sm"><span>{label}</span>{children}</label>;
}
function parseObject(source: string): AdminValue {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Advanced configuration must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Advanced configuration must be a JSON object.");
  return value as AdminValue;
}

export function AdminEditor({ kind, initial = {}, editing = false, onSave, disabled = false }: {
  kind: AdminKind; initial?: AdminValue; editing?: boolean; onSave: (value: AdminValue) => Promise<void>; disabled?: boolean;
}) {
  const [draft, setDraft] = React.useState<AdminValue>(() => ({
    Description: "", Type: kind === "auth-methods" ? "OIDC" : "client", Global: false, Default: false,
    TokenLocality: "local", MaxTokenTTL: "1h", BindType: "role", Scope: "submit-job", EnforcementLevel: "advisory", ...initial,
  }));
  const config = asObject(initial.Config);
  const [authConfig, setAuthConfig] = React.useState<AdminValue>(config);
  const [policyNames, setPolicyNames] = React.useState(() => kind === "roles" ? (Array.isArray(initial.Policies) ? initial.Policies.map(link => String(asObject(link).Name ?? "")).join("\n") : "") : join(initial.Policies));
  const [roleIds, setRoleIds] = React.useState(() => Array.isArray(initial.Roles) ? initial.Roles.map(link => String(asObject(link).ID ?? "")).filter(Boolean).join("\n") : "");
  const [roleNames, setRoleNames] = React.useState(() => Array.isArray(initial.Roles) ? initial.Roles.filter(link => !asObject(link).ID).map(link => String(asObject(link).Name ?? "")).join("\n") : "");
  const [jobACL, setJobACL] = React.useState<AdminValue>(asObject(initial.JobACL));
  const [namespaceConfig, setNamespaceConfig] = React.useState(() => ({
    pool: String(asObject(initial.NodePoolConfiguration).Default ?? ""),
    allowed: join(asObject(initial.NodePoolConfiguration).Allowed), denied: join(asObject(initial.NodePoolConfiguration).Denied),
    enabledDrivers: join(asObject(initial.Capabilities).EnabledTaskDrivers), disabledDrivers: join(asObject(initial.Capabilities).DisabledTaskDrivers),
  }));
  const [advanced, setAdvanced] = React.useState(() => {
    const fields = kind === "namespaces" ? ["Capabilities", "NodePoolConfiguration", "VaultConfiguration", "ConsulConfiguration", "Meta", "RequiredExtraClaims", "OptionalExtraClaims"] : [];
    const value = kind === "auth-methods" ? Object.fromEntries(Object.entries(config).filter(([key]) => !["OIDCDiscoveryURL", "OIDCClientID", "OIDCClientSecret", "AllowedRedirectURIs", "OIDCScopes", "JWKSURL", "JWTValidationPubKeys", "BoundAudiences", "BoundIssuer"].includes(key))) : Object.fromEntries(fields.filter(key => initial[key] !== undefined).map(key => [key, initial[key]]));
    return JSON.stringify(value, null, 2);
  });
  function update(key: string, value: unknown) { setDraft(current => ({ ...current, [key]: value })); }
  function input(key: string, label: string, options: { multiline?: boolean; type?: string; readOnly?: boolean; placeholder?: string } = {}) {
    const props = { "aria-label": label, value: String(draft[key] ?? ""), disabled: disabled || options.readOnly, placeholder: options.placeholder, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update(key, event.target.value) };
    return <Field label={label}>{options.multiline ? <Textarea {...props} rows={8} spellCheck={false} className="font-mono text-xs" /> : <Input {...props} type={options.type ?? "text"} />}</Field>;
  }
  function select(key: string, label: string, values: string[]) {
    return <Field label={label}><select aria-label={label} className={control} value={String(draft[key] ?? values[0])} disabled={disabled} onChange={event => update(key, event.target.value)}>{values.map(value => <option key={value} value={value}>{value}</option>)}</select></Field>;
  }
  function check(key: string, label: string) {
    return <label className="flex items-center gap-2 text-sm"><input aria-label={label} type="checkbox" checked={draft[key] === true} disabled={disabled} onChange={event => update(key, event.target.checked)} />{label}</label>;
  }
  function authField(key: string, label: string, list = false, secret = false) {
    const value = list ? join(authConfig[key]) : String(authConfig[key] ?? "");
    const props = { "aria-label": label, value, disabled, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setAuthConfig(current => ({ ...current, [key]: list ? split(event.target.value) : event.target.value })) };
    return <Field label={label}>{list ? <Textarea {...props} rows={3} /> : <Input {...props} type={secret ? "password" : "text"} autoComplete={secret ? "new-password" : "off"} />}</Field>;
  }
  async function save() {
    const body: AdminValue = { ...draft };
    if (kind === "tokens" && editing) delete body.ExpirationTTL;
    delete body.jwtKeys;
    if (kind === "namespaces") {
      Object.assign(body, parseObject(advanced));
      if (namespaceConfig.pool || namespaceConfig.allowed || namespaceConfig.denied || initial.NodePoolConfiguration) body.NodePoolConfiguration = {
        ...asObject(body.NodePoolConfiguration), Default: namespaceConfig.pool, Allowed: split(namespaceConfig.allowed), Denied: split(namespaceConfig.denied),
      };
      if (namespaceConfig.enabledDrivers || namespaceConfig.disabledDrivers || initial.Capabilities) body.Capabilities = {
        ...asObject(body.Capabilities), EnabledTaskDrivers: split(namespaceConfig.enabledDrivers), DisabledTaskDrivers: split(namespaceConfig.disabledDrivers),
      };
    }
    if (kind === "policies") {
      if (jobACL.JobID || jobACL.Namespace) body.JobACL = jobACL;
      else delete body.JobACL;
    }
    if (kind === "roles") body.Policies = split(policyNames).map(Name => ({ Name }));
    if (kind === "tokens") {
      delete body.SecretID;
      body.Policies = split(policyNames);
      body.Roles = [...split(roleIds).map(ID => ({ ID })), ...split(roleNames).map(Name => ({ Name }))];
      if (editing) delete body.ExpirationTTL;
    }
    if (kind === "auth-methods") {
      const primary = ["OIDCDiscoveryURL", "OIDCClientID", "OIDCClientSecret", "AllowedRedirectURIs", "OIDCScopes", "JWKSURL", "JWTValidationPubKeys", "BoundAudiences", "BoundIssuer"];
      body.Config = { ...parseObject(advanced), ...Object.fromEntries(primary.filter(key => authConfig[key] !== undefined).map(key => [key, authConfig[key]])) };
      if (draft.Type === "JWT" && draft.jwtKeys !== undefined) {
        let keys: unknown;
        try { keys = JSON.parse(String(draft.jwtKeys)); } catch { throw new Error("JWT public keys must be a JSON array of PEM strings."); }
        if (!Array.isArray(keys) || keys.some(key => typeof key !== "string")) throw new Error("JWT public keys must be a JSON array of PEM strings.");
        (body.Config as AdminValue).JWTValidationPubKeys = keys;
      }
    }
    await onSave(body);
  }
  return <section aria-label={`${editing ? "Edit" : "Create"} ${adminTitles[kind]}`} className="space-y-4 rounded-md border border-border p-4">
    <h3 className="text-lg font-semibold">{editing ? "Edit" : "Create"} {adminTitles[kind]}</h3>
    <div className="grid min-w-0 gap-3 md:grid-cols-2">
      {kind !== "binding-rules" && input("Name", kind === "tokens" ? "Token name" : "Name", { readOnly: editing && ["namespaces", "policies", "auth-methods", "sentinel"].includes(kind) })}
      {kind !== "tokens" && kind !== "auth-methods" && input("Description", "Description")}
      {kind === "namespaces" && <>{input("Quota", "Quota (Enterprise)")}{([["pool", "Default node pool"], ["allowed", "Allowed node pools (one per line)"], ["denied", "Denied node pools (one per line)"], ["enabledDrivers", "Enabled task drivers (one per line)"], ["disabledDrivers", "Disabled task drivers (one per line)"]] as const).map(([key, label]) => <Field key={key} label={label}>{key === "pool" ? <Input aria-label={label} value={namespaceConfig[key]} disabled={disabled} onChange={event => setNamespaceConfig(current => ({ ...current, [key]: event.target.value }))} /> : <Textarea aria-label={label} value={namespaceConfig[key]} rows={3} disabled={disabled} onChange={event => setNamespaceConfig(current => ({ ...current, [key]: event.target.value }))} />}</Field>)}</>}
      {kind === "roles" && <Field label="Policy names (one per line)"><Textarea aria-label="Policy names (one per line)" value={policyNames} disabled={disabled} onChange={event => setPolicyNames(event.target.value)} rows={4} /></Field>}
      {kind === "tokens" && <>
        {select("Type", "Token type", ["client", "management"])}{check("Global", "Global token")}
        <Field label="Policy names (one per line)"><Textarea aria-label="Policy names (one per line)" value={policyNames} disabled={disabled} onChange={event => setPolicyNames(event.target.value)} rows={4} /></Field>
        <Field label="Role IDs (one per line)"><Textarea aria-label="Role IDs (one per line)" value={roleIds} disabled={disabled} onChange={event => setRoleIds(event.target.value)} rows={3} /></Field>
        <Field label="Role names (one per line)"><Textarea aria-label="Role names (one per line)" value={roleNames} disabled={disabled} onChange={event => setRoleNames(event.target.value)} rows={3} /></Field>
        {!editing && input("ExpirationTTL", "Expiration TTL", { placeholder: "8h (optional)" })}
        {input("ExpirationTime", "Expiration time (RFC3339)", { placeholder: "2027-01-01T00:00:00Z (optional)" })}
      </>}
      {kind === "auth-methods" && <>
        {select("Type", "Authentication type", ["OIDC", "JWT"])}{select("TokenLocality", "Token locality", ["local", "global"])}
        {input("MaxTokenTTL", "Maximum token TTL")}{input("TokenNameFormat", "Token name format")}{check("Default", "Default authentication method")}
        {draft.Type === "OIDC" ? <>{authField("OIDCDiscoveryURL", "OIDC discovery URL")}{authField("OIDCClientID", "OIDC client ID")}{authField("OIDCClientSecret", "OIDC client secret", false, true)}{authField("AllowedRedirectURIs", "Allowed redirect URIs (one per line)", true)}{authField("OIDCScopes", "OIDC scopes (one per line)", true)}</> : <>{authField("JWKSURL", "JWKS URL")}<Field label="JWT validation public keys (JSON array)"><Textarea aria-label="JWT validation public keys (JSON array)" value={String(draft.jwtKeys ?? JSON.stringify(authConfig.JWTValidationPubKeys ?? [], null, 2))} disabled={disabled} rows={5} onChange={event => update("jwtKeys", event.target.value)} /></Field></>}
        {authField("BoundAudiences", "Bound audiences (one per line)", true)}{authField("BoundIssuer", "Bound issuers (one per line)", true)}
      </>}
      {kind === "binding-rules" && <>{input("AuthMethod", "Authentication method name")}{input("Selector", "Claim selector")}{select("BindType", "Binding type", ["role", "policy", "management"])}{input("BindName", "Binding name or template")}</>}
      {kind === "sentinel" && <>{select("Scope", "Policy scope", ["submit-job", "submit-host-volume", "submit-csi-volume"])}{select("EnforcementLevel", "Enforcement level", ["advisory", "soft-mandatory", "hard-mandatory"])}</>}
    </div>
    {kind === "policies" && <>
      {input("Rules", "HCL rules", { multiline: true })}
      <details><summary className="cursor-pointer text-sm">Workload identity attachment (optional)</summary><div className="mt-3 grid gap-3 md:grid-cols-2">{[["Namespace", "Job namespace"], ["JobID", "Job ID"], ["Group", "Task group"], ["Task", "Task"]].map(([key, label]) => <Field key={key} label={label}><Input aria-label={label} value={String(jobACL[key] ?? "")} disabled={disabled} onChange={event => setJobACL(current => ({ ...current, [key]: event.target.value }))} /></Field>)}</div></details>
    </>}
    {kind === "sentinel" && <>{input("Policy", "Sentinel policy source", { multiline: true })}<p className="text-sm text-muted-foreground">Sentinel requires an appropriate Nomad Enterprise edition. Server edition and ACL denials remain visible.</p></>}
    {["namespaces", "auth-methods"].includes(kind) && <details><summary className="cursor-pointer text-sm">{kind === "namespaces" ? "Namespace configuration: drivers, node pools, metadata and Enterprise integrations" : "Advanced authentication configuration: claim mappings, signing, CA certificates and assertions"}</summary><Field label="Advanced configuration JSON"><Textarea aria-label="Advanced configuration JSON" className="mt-2 font-mono text-xs" value={advanced} disabled={disabled} rows={10} spellCheck={false} onChange={event => setAdvanced(event.target.value)} /></Field></details>}
    <ConfirmAction label={editing ? "Save changes" : "Create resource"} description={`Confirm ${editing ? "updating" : "creating"} ${adminTitles[kind]}. This changes Nomad administration settings and may affect access.`} disabled={disabled} onConfirm={save} />
  </section>;
}
