import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ConsulApiStatus, IntegrationUiLinks, JobConsulHealth } from "../../src/frontend/ConsulIntegration";
import { RefreshContext } from "../../src/frontend/ResourceUI";
import type { ResourceApi } from "../../src/frontend/ResourceUI";
import type { JobConsulStatus, NomadApi } from "../../src/frontend/nomad-api";

afterEach(cleanup);
const uiUrl = "https://consul.example/ui/";
function health(overrides: Partial<JobConsulStatus> = {}): JobConsulStatus {
  return { configured: true, status: "connected", usesConsul: true, health: "passing", checks: [{ id: "check-1", serviceId: "service-1", serviceName: "web", name: "HTTP health", node: "worker-1", status: "passing", output: "HTTP 200" }], expectedServices: 1, partial: false, uiUrl, ...overrides };
}
function apiStub(data = health()) {
  return { jobConsul: vi.fn(async () => data) } as unknown as NomadApi;
}

describe("Consul UI links", () => {
  it.each(["javascript:alert(1)", "data:text/html,test", "/ui/", "//consul.example/ui/", "https://user:secret@consul.example/ui/", "https://consul.example/ui/?token=secret", "https://consul.example/ui/#token=secret", "https://consul.example/ui/?", "https://consul.example/ui/#", "not a URL"])("rejects unsafe URL %s", url => {
    render(<IntegrationUiLinks url={url} nomadUrl={url} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each([uiUrl, "http://100.88.18.82:8500/ui/"])("opens a configured HTTP(S) UI safely: %s", url => {
    render(<IntegrationUiLinks url={url} />);
    const link = screen.getByRole("link", { name: "Open Consul UI" });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps a safe link when the other UI URL is unsafe", () => {
    render(<IntegrationUiLinks url={uiUrl} nomadUrl="javascript:alert(1)" />);
    expect(screen.queryByRole("link", { name: "Open Nomad UI" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Consul UI" }).getAttribute("href")).toBe(uiUrl);
  });

  it("allows native Nomad UI access when Consul is not configured", async () => {
    const api = { get: vi.fn(async () => ({ configured: false, status: "unconfigured", nomadUiUrl: "https://nomad.example/ui/" })) };
    render(<ConsulApiStatus api={api as unknown as ResourceApi} tick={0} />);
    expect(await screen.findByRole("link", { name: "Open Nomad UI" })).toHaveProperty("href", "https://nomad.example/ui/");
    expect(screen.queryByText(/Consul API:/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Open Consul UI" })).toBeNull();
  });
});

describe("Consul job health", () => {
  it.each(["passing", "warning", "critical", "unknown"] as const)("shows %s and actual service check details", async state => {
    const api = apiStub(health({ health: state }));
    render(<JobConsulHealth api={api} jobId="web" refresh={0} />);
    expect(await screen.findByText(`Consul health: ${state}`)).toBeTruthy();
    expect(screen.getByText("web / HTTP health / node worker-1 / passing")).toBeTruthy();
    expect(screen.getByText("HTTP 200")).toBeTruthy();
    expect(screen.getByText("1 expected service registrations / 1 checks")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Consul UI" })).toBeTruthy();
    expect(api.jobConsul).toHaveBeenCalledWith("web");
  });

  it("explains unconfigured Consul instead of claiming running allocations are healthy", async () => {
    render(<JobConsulHealth api={apiStub(health({ configured: false, status: "unconfigured", health: "unknown", checks: [], uiUrl: undefined }))} jobId="web" refresh={0} />);
    expect(await screen.findByText("Consul health: unknown")).toBeTruthy();
    expect(screen.getByText(/Configure a Consul API address and read-only token/)).toBeTruthy();
    expect(screen.getByText("No Consul checks are available. Service health is unknown.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("marks incomplete data unknown even when the observed checks pass", async () => {
    render(<JobConsulHealth api={apiStub(health({ partial: true }))} jobId="web" refresh={0} />);
    expect(await screen.findByText("Consul health: unknown")).toBeTruthy();
    expect(screen.getByText(/Incomplete Consul health data/)).toBeTruthy();
    expect(screen.getByText("HTTP 200")).toBeTruthy();
  });

  it.each(["warning", "critical"] as const)("preserves known %s health even when other service data is incomplete", async state => {
    render(<JobConsulHealth api={apiStub(health({ partial: true, health: state }))} jobId="web" refresh={0} />);
    expect(await screen.findByText(`Consul health: ${state}`)).toBeTruthy();
    expect(screen.getByText(/Incomplete Consul health data/)).toBeTruthy();
  });

  it("shows ACL failure as unknown while retaining the troubleshooting link", async () => {
    render(<JobConsulHealth api={apiStub(health({ status: "error", health: "unknown", checks: [], error: "Consul ACL denied" }))} jobId="web" refresh={0} />);
    expect(await screen.findByText("Consul health: unknown")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Consul ACL denied");
    expect(screen.getByRole("link")).toBeTruthy();
  });

  it("refreshes on ticks and manual refresh without presenting old checks on request failure", async () => {
    const api = apiStub();
    const view = (tick: number, refresh: number) => <RefreshContext.Provider value={tick}><JobConsulHealth api={api} jobId="web" refresh={refresh} /></RefreshContext.Provider>;
    const { rerender } = render(view(0, 0));
    await screen.findByText("Consul health: passing");
    vi.mocked(api.jobConsul).mockResolvedValueOnce(health({ health: "critical" }));
    rerender(view(1, 0));
    await screen.findByText("Consul health: critical");
    vi.mocked(api.jobConsul).mockRejectedValueOnce(new Error("Connection refused"));
    rerender(view(1, 1));
    await screen.findByText("Consul health: unknown");
    expect(screen.getByRole("alert").textContent).toContain("Connection refused");
    expect(screen.queryByText("HTTP 200")).toBeNull();
    expect(screen.getByRole("link")).toBeTruthy();
    expect(api.jobConsul).toHaveBeenCalledTimes(3);
  });

  it("discards a late response after a new job and namespace API are selected", async () => {
    const pending = Promise.withResolvers<JobConsulStatus>();
    const oldApi = apiStub();
    vi.mocked(oldApi.jobConsul).mockReturnValue(pending.promise);
    const newApi = apiStub(health({ health: "warning", uiUrl: "https://team-b.example/ui/" }));
    const { rerender } = render(<JobConsulHealth api={oldApi} jobId="old" refresh={0} />);
    rerender(<JobConsulHealth api={newApi} jobId="new" refresh={0} />);
    await screen.findByText("Consul health: warning");
    await act(async () => { pending.resolve(health({ health: "critical" })); });
    expect(screen.queryByText("Consul health: critical")).toBeNull();
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://team-b.example/ui/");
  });

  it("does not let a late previous refresh overwrite a newer result", async () => {
    const pending = Promise.withResolvers<JobConsulStatus>();
    const api = apiStub();
    vi.mocked(api.jobConsul).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(health({ health: "critical" }));
    const { rerender } = render(<JobConsulHealth api={api} jobId="web" refresh={0} />);
    rerender(<JobConsulHealth api={api} jobId="web" refresh={1} />);
    await screen.findByText("Consul health: critical");
    await act(async () => { pending.resolve(health()); });
    expect(screen.queryByText("Consul health: passing")).toBeNull();
  });
});
