import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";

const state = vi.hoisted(() => ({ manage: false, use: true, hosts: [] as PluginHostRecord[], get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useHost: () => null,
  useHosts: () => ({ hosts: state.hosts, loaded: true }),
  usePermission: (permission: string) => permission === "manage" ? state.manage : permission === "use" && state.use,
  usePluginApi: () => state,
}));
vi.mock("../../src/frontend/JobSourceEditor", () => ({
  JobSourceEditor: ({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) => <textarea aria-label={label} value={value} onChange={event => onChange(event.target.value)} />,
}));
import { NomadHome, NomadManager } from "../../src/frontend/NomadManager";

const host: PluginHostRecord = { id: "7", name: "cluster", ip: "10.0.0.7", port: 22, pluginSettings: { nomad: { enableNomad: true } } };
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); state.manage = false; state.use = true; state.hosts = [];
  state.get.mockImplementation(async (url: string, options?: { params?: { namespace?: string } }) => {
    const path = new URL(url, "http://plugin").pathname;
    if (path.endsWith("/namespaces")) throw { response: { data: { error: "ACL denied" } } };
    if (path.endsWith("/status")) return { data: { leader: "leader:4647" } };
    if (path.endsWith("/consul")) return { data: { configured: false, status: "unconfigured" } };
    if (path.endsWith("/nodes")) return { data: { items: [{ ID: "node-1", Name: `worker-${options?.params?.namespace ?? "default"}`, Status: "ready", Datacenter: "dc1" }], nextToken: "" } };
    if (path.endsWith("/stats")) return { data: {} };
    return { data: { items: [], nextToken: "" } };
  });
  state.post.mockImplementation(async (url: string) => ({ data: url.includes("/parse?") ? { ID: "web", Namespace: new URL(url, "http://plugin").searchParams.get("namespace") } : url.includes("/validate?") ? { DriverConfigValidated: true, ValidationErrors: [], Error: "", Warnings: "" } : { JobModifyIndex: 8, Diff: { Type: "Added" } } }));
  state.put.mockResolvedValue({ data: {} }); state.delete.mockResolvedValue({ data: {} });
});

async function plan() {
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  fireEvent.click(screen.getByRole("button", { name: "Run job" }));
  fireEvent.change(screen.getByLabelText("Job source"), { target: { value: 'job "web" {}' } });
  fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
  await screen.findByRole("button", { name: "Deploy planned job" });
}

describe("Nomad workspace boundaries", () => {
  it("retains manual namespace access when discovery is denied", async () => {
    render(<NomadManager host={host} />);
    await screen.findByText(/Namespace enumeration is unavailable/);
    fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: "team-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Clients" }));
    expect(await screen.findByText("worker-team-a")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Administration" })).toBeNull();
  });

  it("does not load a disabled connection or bypass read permission", () => {
    state.use = false;
    const { rerender } = render(<NomadManager host={host} />);
    expect(screen.getByText("Nomad read permission is required.")).toBeTruthy();
    expect(state.get).not.toHaveBeenCalled();
    state.use = true;
    rerender(<NomadManager host={{ ...host, pluginSettings: {} }} />);
    expect(screen.getByText("Nomad is not enabled for this host.")).toBeTruthy();
    expect(state.get).not.toHaveBeenCalled();
  });

  it("discards planned deployment when namespace or connection changes", async () => {
    state.manage = true;
    const { rerender } = render(<NomadManager host={host} />);
    await plan();
    fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: "team-a" } });
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    await plan();
    rerender(<NomadManager host={{ ...host, pluginSettings: { nomad: { enableNomad: true, address: "https://other:4646" } } }} />);
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    expect(state.put).not.toHaveBeenCalled();
  });

  it("does not open disabled or view-only shared clusters from main navigation", () => {
    state.hosts = [{ ...host, pluginSettings: {} }, { ...host, id: "8", isShared: true, permissionLevel: "view" }];
    render(<NomadHome />);
    expect(screen.getByText(/No accessible Nomad clusters/)).toBeTruthy();
    expect(screen.queryByLabelText("Namespace")).toBeNull();
    expect(state.get).not.toHaveBeenCalled();
  });

  it("discards pending deployments on cluster changes and unmounts revoked access", async () => {
    state.manage = true;
    state.hosts = [host, { ...host, id: "8", name: "other-cluster" }];
    const { rerender } = render(<NomadHome />);
    await plan();
    fireEvent.change(screen.getByLabelText("Nomad cluster"), { target: { value: "8" } });
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Nomad / other-cluster" })).toBeTruthy();
    await plan();
    state.hosts = [host];
    rerender(<NomadHome />);
    expect(screen.queryByLabelText("Namespace")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    expect(state.put).not.toHaveBeenCalled();
  });
});

describe("Consul API workspace status", () => {
  it("hides unconfigured integration", async () => {
    render(<NomadManager host={host} />);
    await waitFor(() => expect(state.get).toHaveBeenCalledWith("/hosts/7/consul", { params: { namespace: "default" } }));
    expect(screen.queryByLabelText("Consul API")).toBeNull();
  });

  it("refreshes the API status and retains the safe UI link after connection failure", async () => {
    const fallback = state.get.getMockImplementation()!;
    let fail = false;
    state.get.mockImplementation(async (url: string, options: unknown) => {
      if (!url.endsWith("/consul")) return fallback(url, options);
      if (fail) throw new Error("Consul connection refused");
      return { data: { configured: true, status: "connected", uiUrl: "https://consul.example/ui/" } };
    });
    render(<NomadManager host={host} />);
    await screen.findByText("Consul API: connected");
    const header = within(screen.getByLabelText("Consul API"));
    expect(header.getByRole("link", { name: "Open Consul UI" }).getAttribute("href")).toBe("https://consul.example/ui/");
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));
    await screen.findByText("Consul API: unavailable");
    expect(header.getByRole("alert").textContent).toContain("Consul connection refused");
    expect(header.getByRole("link", { name: "Open Consul UI" })).toBeTruthy();
  });

  it("shows a configured API without inventing a UI URL", async () => {
    const fallback = state.get.getMockImplementation()!;
    state.get.mockImplementation(async (url: string, options: unknown) => url.endsWith("/consul") ? { data: { configured: true, status: "connected" } } : fallback(url, options));
    render(<NomadManager host={host} />);
    await screen.findByText("Consul API: connected");
    expect(within(screen.getByLabelText("Consul API")).queryByRole("link")).toBeNull();
  });

  it("does not paint another host with a late Consul response", async () => {
    const fallback = state.get.getMockImplementation()!;
    const pending = Promise.withResolvers<{ data: unknown }>();
    state.get.mockImplementation(async (url: string, options: unknown) => {
      if (url === "/hosts/7/consul") return pending.promise;
      if (url.endsWith("/consul")) return { data: { configured: true, status: "error", error: "New cluster ACL denied", uiUrl: "https://new-cluster.example/ui/" } };
      return fallback(url, options);
    });
    const { rerender } = render(<NomadManager host={host} />);
    rerender(<NomadManager host={{ ...host, id: "8", name: "other" }} />);
    await screen.findByText("New cluster ACL denied");
    await act(async () => { pending.resolve({ data: { configured: true, status: "connected", uiUrl: "https://old-cluster.example/ui/" } }); });
    const header = within(screen.getByLabelText("Consul API"));
    expect(header.getByText("Consul API: unavailable")).toBeTruthy();
    expect(header.getByRole("link").getAttribute("href")).toBe("https://new-cluster.example/ui/");
  });
});
