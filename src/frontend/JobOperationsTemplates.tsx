import React from "react";
import { Button, Input, Textarea } from "@termix-ssh/plugin-sdk/ui";
import { ConfirmAction, ErrorMessage, ResourceBrowser, type ResourceApi } from "./ResourceUI";
import { errorMessage, type Format } from "./nomad-api";

interface Template { Path: string; Namespace: string; ModifyIndex: number; Items: Record<string, string> }
export function JobTemplates({ api, source, format, canManage, onLoad }: { api: ResourceApi; source: string; format: Format; canManage: boolean; onLoad(source: string): void }) {
  const [selected, setSelected] = React.useState<Template | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [refresh, setRefresh] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const prefix = "nomad/job-templates/";
  return <section aria-label="Job templates" className="space-y-3 rounded-md border border-border p-3">
    <h3 className="font-medium">Job templates</h3><p className="text-sm text-muted-foreground">Templates are HCL stored in Nomad variables at nomad/job-templates/&lt;name&gt; with template and description items. Variable ACLs and server support apply.</p>
    <ResourceBrowser key={refresh} api={api} endpoint="/variables" query={{ prefix }} title="Saved templates" columns={[{ key: "Path", title: "Template path" }, { key: "Namespace", title: "Namespace" }]} onSelect={row => {
      setLoading(true); setError(""); setMessage("");
      void api.get<Template>("/variable", { path: String(row.Path) }).then(template => {
        if (!template.Path.startsWith(prefix) || typeof template.Items?.template !== "string") throw new Error("Variable does not contain a job template.");
        setSelected(template); setName(template.Path.slice(prefix.length)); setDescription(template.Items.description ?? "");
      }).catch(cause => setError(errorMessage(cause))).finally(() => setLoading(false));
    }} />
    <ErrorMessage error={error} />{message && <p role="status" className="text-sm">{message}</p>}{loading && <p role="status">Loading template...</p>}
    {selected && <div className="space-y-2"><p className="break-words text-sm">Selected: {selected.Path} / modification index {selected.ModifyIndex}</p><p className="text-sm">{selected.Items.description}</p><Button variant="outline" onClick={() => onLoad(selected.Items.template)}>Load template into editor</Button><details><summary className="cursor-pointer text-sm">Preview template source</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{selected.Items.template}</pre></details></div>}
    {canManage && <div className="space-y-3 border-t border-border pt-3">
      <label className="block text-sm">Template name<Input aria-label="Template name" value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block text-sm">Template description<Textarea aria-label="Template description" rows={2} value={description} onChange={event => setDescription(event.target.value)} /></label>
      {format !== "hcl" && <p className="text-sm">Save templates from HCL format, matching the Nomad UI convention.</p>}
      <div className="flex flex-wrap gap-2"><ConfirmAction label="Save as new template" description={`Create ${prefix}${name} from the current HCL editor source? Existing variables will not be overwritten.`} disabled={format !== "hcl" || !name.trim() || !source.trim()} onConfirm={async () => {
        const saved = await api.put<Template>("/variable", { Path: `${prefix}${name}`, Items: { template: source, description }, ModifyIndex: 0 });
        setSelected(saved); setMessage("Template created."); setRefresh(value => value + 1);
      }} />
      {selected && <><ConfirmAction label="Update selected template" description={`Replace the HCL source and description of ${selected.Path}? A concurrent edit will be rejected.`} disabled={format !== "hcl" || !source.trim()} onConfirm={async () => {
        const saved = await api.put<Template>("/variable", { Path: selected.Path, Items: { ...selected.Items, template: source, description }, ModifyIndex: selected.ModifyIndex });
        setSelected(saved); setMessage("Template updated."); setRefresh(value => value + 1);
      }} /><ConfirmAction label="Delete selected template" danger description={`Permanently delete ${selected.Path}? A concurrent edit will be rejected.`} onConfirm={async () => { await api.del("/variable", { path: selected.Path, cas: selected.ModifyIndex }); setSelected(null); setMessage("Template deleted."); setRefresh(value => value + 1); }} /></>}
      </div>
    </div>}
  </section>;
}
