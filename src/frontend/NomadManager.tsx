import React from "react";
import { useHost, useHosts, usePermission, type PluginHostRecord, type TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { Button, Input } from "@termix-ssh/plugin-sdk/ui";
import { Activity, Boxes, Database, KeyRound, Layers, Network, Server, Settings2, Waypoints } from "lucide-react";
import { DashboardPage, NodesPage, ServersPage, NodePoolsPage } from "./ClusterPage";
import { JobsPage, DeploymentsPage, EvaluationsPage } from "./JobsPage";
import { AllocationsPage } from "./AllocationPage";
import { ServicesPage, VolumesPage, VariablesPage } from "./StoragePages";
import { AdministrationPage } from "./AdministrationPage";
import { ErrorMessage, RefreshContext, ResourceTransportContext, useResourceApi, type PageProps } from "./ResourceUI";
import { ConsulApiStatus } from "./ConsulIntegration";

type Transport = Pick<TermixApp, "fetch" | "wsUrl">;
const sections = [
  { id: "dashboard", title: "Overview & topology", icon: Waypoints, component: DashboardPage },
  { id: "jobs", title: "Jobs", icon: Boxes, component: JobsPage },
  { id: "allocations", title: "Allocations", icon: Layers, component: AllocationsPage },
  { id: "deployments", title: "Deployments", icon: Activity, component: DeploymentsPage },
  { id: "evaluations", title: "Evaluations", icon: Activity, component: EvaluationsPage },
  { id: "nodes", title: "Clients", icon: Server, component: NodesPage },
  { id: "servers", title: "Servers", icon: Server, component: ServersPage },
  { id: "node-pools", title: "Node pools", icon: Network, component: NodePoolsPage },
  { id: "services", title: "Services", icon: Network, component: ServicesPage },
  { id: "volumes", title: "Storage", icon: Database, component: VolumesPage },
  { id: "variables", title: "Variables", icon: KeyRound, component: VariablesPage },
  { id: "administration", title: "Administration", icon: Settings2, component: AdministrationPage },
];

export function nomadEnabled(host?: PluginHostRecord | null) {
  return host?.pluginSettings?.nomad?.enableNomad === true;
}

export function NomadHome({ transport }: { transport?: Transport }) {
  const { hosts, loaded } = useHosts();
  const canUse = usePermission("use");
  const [selectedId, setSelectedId] = React.useState("");
  const clusters = hosts.filter(host => nomadEnabled(host) && (!host.isShared || ["connect", "edit", "manage"].includes(host.permissionLevel ?? "")));
  const selected = selectedId ? clusters.find(host => String(host.id) === selectedId) : clusters[0];
  if (!canUse) return <p className="p-4 text-sm">Nomad read permission is required.</p>;
  if (!loaded) return <p className="p-4 text-sm">Loading Nomad clusters...</p>;
  return <div className="flex h-full min-w-0 flex-col bg-background text-foreground">
    <header className="space-y-2 border-b border-border p-4">
      <h1 className="text-lg font-semibold">Nomad clusters</h1>
      <p className="text-xs text-muted-foreground">Choose a cluster endpoint to manage its clients and workloads. Connections follow your Termix account's host permissions.</p>
      {clusters.length > 0 ? <label className="block text-sm">Cluster<select aria-label="Nomad cluster" className="mt-1 block h-9 max-w-full rounded-md border border-border bg-background px-2 text-sm" value={selected ? String(selected.id) : ""} onChange={event => setSelectedId(event.target.value)}>
        <option value="" disabled>Select a cluster</option>
        {clusters.map(host => <option key={host.id} value={String(host.id)}>{host.name || host.ip}</option>)}
      </select></label> : <p className="text-sm">No accessible Nomad clusters. Enable Nomad on one of your hosts, or ask its owner to share connect access. Hosts owned by another account are not automatically visible.</p>}
    </header>
    <div className="min-h-0 flex-1">{selected && <NomadManager host={selected} transport={transport} />}</div>
  </div>;
}

export function NomadManager({ host, hostId, transport }: { host?: PluginHostRecord; hostId?: string | number; transport?: Transport }) {
  const live = useHost(host?.id ?? hostId);
  const currentHost = live ?? host;
  const canUse = usePermission("use");
  const canManage = usePermission("manage");
  const canAdmin = usePermission("administer");
  const canExec = usePermission("exec");
  if (!canUse) return <p className="p-4 text-sm">Nomad read permission is required.</p>;
  if (!currentHost) return <p className="p-4 text-sm">Select a host to open Nomad.</p>;
  if (!nomadEnabled(currentHost)) return <p className="p-4 text-sm">Nomad is not enabled for this host.</p>;
  // A connection change must discard data, draft plans and privileged sessions together.
  const context = JSON.stringify([currentHost.id, currentHost.ip, currentHost.pluginSettings?.nomad]);
  return <ResourceTransportContext.Provider value={transport ?? null}><HostWorkspace key={context} host={currentHost} canManage={canManage} canAdmin={canAdmin} canExec={canExec} transport={transport} /></ResourceTransportContext.Provider>;
}

function HostWorkspace({ host, canManage, canAdmin, canExec, transport }: { host: PluginHostRecord; canManage: boolean; canAdmin: boolean; canExec: boolean; transport?: Transport }) {
  const [namespace, setNamespace] = React.useState("default");
  const [namespaceInput, setNamespaceInput] = React.useState("default");
  const [resource, setResource] = React.useState("dashboard");
  const [selectedId, setSelectedId] = React.useState<string>();
  const [namespaces, setNamespaces] = React.useState<{ Name: string }[]>([]);
  const [namespaceError, setNamespaceError] = React.useState<unknown>();
  const [leader, setLeader] = React.useState("");
  const [statusError, setStatusError] = React.useState<unknown>();
  const [tick, setTick] = React.useState(0);
  const [refreshSeconds, setRefreshSeconds] = React.useState(10);
  const api = useResourceApi(host.id, namespace || "default");
  React.useEffect(() => {
    if (!refreshSeconds) return;
    const timer = setInterval(() => { if (!document.hidden) setTick((value) => value + 1); }, refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [refreshSeconds]);
  React.useEffect(() => {
    let active = true;
    void api.get<{ Name: string }[]>("/namespaces").then((list) => { if (active) { setNamespaces(list); setNamespaceError(undefined); } }).catch((error: unknown) => { if (active) setNamespaceError(error); });
    return () => { active = false; };
  }, [api]);
  React.useEffect(() => {
    let active = true;
    void api.get<{ leader: string }>("/status").then((status) => { if (active) { setLeader(status.leader); setStatusError(undefined); } }).catch((error: unknown) => { if (active) setStatusError(error); });
    return () => { active = false; };
  }, [api, tick]);
  const onNavigate = React.useCallback((next: string, id?: string, scope?: string) => {
    if (!sections.some((section) => section.id === next)) return;
    if (scope && scope !== namespace) { setNamespace(scope); setNamespaceInput(scope); }
    setResource(next); setSelectedId(id);
  }, [namespace]);
  const section = sections.find((item) => item.id === resource)!;
  const Page = section.component as React.ComponentType<PageProps>;
  return <main className="h-full min-w-0 overflow-auto bg-background p-3 text-foreground sm:p-5">
    <div className="mx-auto min-w-0 max-w-screen-2xl space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0"><h1 className="break-words text-lg font-semibold">Nomad / {host.name || host.ip}</h1><p className="mt-1 break-all text-xs text-muted-foreground">Region: {String(host.pluginSettings?.nomad?.region || "global")} / Leader: {leader || "unavailable"}</p><ConsulApiStatus api={api} tick={tick} /></div>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="min-w-0 text-xs">Namespace<Input aria-label="Namespace" list="nomad-namespaces" className="mt-1 w-40 max-w-full" value={namespaceInput} onChange={(event) => { setNamespaceInput(event.target.value); setNamespace(event.target.value.trim()); setSelectedId(undefined); }} /></label>
          <datalist id="nomad-namespaces"><option value="*" />{namespaces.map((item) => <option key={item.Name} value={item.Name} />)}</datalist>
          <label className="text-xs">Live refresh<select aria-label="Live refresh" className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm" value={refreshSeconds} onChange={(event) => setRefreshSeconds(Number(event.target.value))}><option value={0}>Off</option><option value={5}>5 seconds</option><option value={10}>10 seconds</option><option value={30}>30 seconds</option></select></label>
          <Button variant="outline" onClick={() => setTick((value) => value + 1)}>Refresh all</Button>
        </div>
      </header>
      <ErrorMessage error={statusError} />
      {namespaceError && <div className="text-xs"><ErrorMessage error={namespaceError} /><p className="mt-1 text-muted-foreground">Namespace enumeration is unavailable. Enter a permitted namespace manually.</p></div>}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[11rem_minmax(0,1fr)]">
        <nav aria-label="Nomad resources" className="flex min-w-0 flex-wrap content-start gap-1 lg:flex-col">
          {sections.filter((item) => item.id !== "administration" || canAdmin).map(({ id, title, icon: Icon }) => <Button key={id} variant={resource === id ? "secondary" : "ghost"} className="h-auto justify-start gap-2 whitespace-normal px-3 py-2 text-left text-xs lg:w-full" aria-current={resource === id ? "page" : undefined} onClick={() => onNavigate(id)}><Icon size={15} aria-hidden="true" />{title}</Button>)}
          <p className="mt-3 hidden text-xs text-muted-foreground lg:block">Connection tokens stay on the server. Termix permissions and Nomad ACLs both apply.</p>
        </nav>
        <div className="min-w-0 space-y-3">
          {!canManage && <p className="text-xs text-muted-foreground">Read-only workload access. Planning is available; writes require manage permission.</p>}
          {namespace === "*" && <p className="rounded-md border border-border p-2 text-xs text-muted-foreground">All namespaces: select a resource's concrete namespace before modifying it.</p>}
          <RefreshContext.Provider value={tick}>{namespace ? <Page key={`${namespace}/${resource}`} hostId={host.id} namespace={namespace} canManage={canManage && namespace !== "*"} canAdmin={canAdmin} canExec={canExec && namespace !== "*"} selectedId={selectedId} onNavigate={onNavigate} socketUrl={transport?.wsUrl} /> : <p className="text-sm">Enter a namespace.</p>}</RefreshContext.Provider>
        </div>
      </div>
    </div>
  </main>;
}
