import React from "react";
import { errorMessage, type ConsulStatus, type JobConsulStatus, type NomadApi } from "./nomad-api";
import { useRefreshTick, type ResourceApi } from "./ResourceUI";

export function IntegrationUiLinks({ url, nomadUrl }: { url?: string; nomadUrl?: string }) {
  return <div className="flex flex-wrap gap-x-3 gap-y-1">{[{ label: "Open Nomad UI", url: nomadUrl }, { label: "Open Consul UI", url }].map(link => {
    if (!link.url) return null;
    try {
      const parsed = new URL(link.url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || /[\x00-\x20\x7f?#]/.test(link.url)) return null;
    } catch { return null; }
    return <a key={link.label} className="break-all underline underline-offset-2" href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>;
  })}</div>;
}

export function ConsulApiStatus({ api, tick }: { api: ResourceApi; tick: number }) {
  const [result, setResult] = React.useState<{ api: ResourceApi; data: ConsulStatus }>();
  React.useEffect(() => {
    let active = true;
    void api.get<ConsulStatus>("/consul").then(data => { if (active) setResult({ api, data }); })
      .catch((cause: unknown) => {
        if (active) setResult(previous => ({ api, data: { ...(previous?.api === api ? previous.data : { configured: true }), status: "error", error: errorMessage(cause) } }));
      });
    return () => { active = false; };
  }, [api, tick]);
  const data = result?.api === api ? result.data : undefined;
  if (!data?.configured && !data?.nomadUiUrl) return null;
  return <div className="mt-2 space-y-1 text-xs" aria-label="Consul API">
    {data.configured && <p>Consul API: {data.status === "connected" ? "connected" : "unavailable"}</p>}
    {data.configured && data.status === "error" && <p role="alert" className="break-words text-destructive">{data.error || "Consul API is unavailable. Check its connection and ACL permissions."}</p>}
    <IntegrationUiLinks url={data.uiUrl} nomadUrl={data.nomadUiUrl} />
  </div>;
}

export function JobConsulHealth({ api, jobId, refresh }: { api: NomadApi; jobId: string; refresh: number }) {
  const tick = useRefreshTick();
  const [result, setResult] = React.useState<{ api: NomadApi; jobId: string; data?: JobConsulStatus; error?: string; loading: boolean }>();
  React.useEffect(() => {
    let active = true;
    setResult(previous => ({ api, jobId, data: previous?.api === api && previous.jobId === jobId ? previous.data : undefined, loading: true }));
    void api.jobConsul(jobId).then(data => { if (active) setResult({ api, jobId, data, loading: false }); })
      .catch((cause: unknown) => {
        if (active) setResult(previous => ({ api, jobId, data: previous?.api === api && previous.jobId === jobId ? previous.data : undefined, error: errorMessage(cause), loading: false }));
      });
    return () => { active = false; };
  }, [api, jobId, refresh, tick]);
  const current = result?.api === api && result.jobId === jobId ? result : undefined;
  const data = current?.data;
  if (data?.usesConsul === false) return null;
  const loading = !current || current.loading;
  const health = current?.error || data?.status !== "connected" || (data.partial && data.health === "passing") ? "unknown" : data.health;
  return <section aria-label="Consul service health" className="space-y-2 rounded-md border border-border p-3 text-sm">
    <h3 className="font-medium">Consul service health</h3>
    {loading ? <p role="status">Loading Consul health...</p> : <>
      <p>Consul health: {health}</p>
      {current?.error && <p role="alert" className="break-words text-destructive">Consul health unavailable: {current.error}</p>}
      {data?.status === "unconfigured" && <p>Configure a Consul API address and read-only token in this host's Nomad settings to view service health.</p>}
      {data?.error && !current?.error && <p role="alert" className="break-words text-destructive">{data.error}</p>}
      {data?.status === "error" && !data.error && !current?.error && <p role="alert">Consul API is unavailable. Check its connection and ACL permissions.</p>}
      {data?.partial && <p>Incomplete Consul health data; some expected service registrations or checks are unavailable.</p>}
      {!current?.error && data && <>
        <p className="text-xs text-muted-foreground">{data.expectedServices} expected service registrations / {data.checks.length} checks</p>
        {data.checks.length === 0 ? <p>No Consul checks are available. Service health is unknown.</p> : <ul className="space-y-2">{data.checks.map(check => <li key={`${check.node}/${check.serviceId}/${check.id}`} className="space-y-1 break-words border-l-2 border-border pl-3">
          <p>{check.serviceName || check.serviceId} / {check.name || check.id} / node {check.node || "unknown"} / {check.status || "unknown"}</p>
          {check.output && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{check.output}</p>}
        </li>)}</ul>}
      </>}
    </>}
    <IntegrationUiLinks url={data?.uiUrl} nomadUrl={data?.nomadUiUrl} />
  </section>;
}
