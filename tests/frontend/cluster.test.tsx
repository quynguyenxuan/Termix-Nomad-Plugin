import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DashboardPage, NodePoolsPage, NodesPage, ServersPage } from "../../src/frontend/ClusterPage";
import { RefreshContext, ResourceTransportContext, type PageProps } from "../../src/frontend/ResourceUI";

const client = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({ usePluginApi: () => client }));
const props: PageProps = { hostId: "7", namespace: "default", canManage: true, canAdmin: true, canExec: false, onNavigate: vi.fn() };
const node = { ID: "node-1", Name: "worker-a", NodePool: "team", Datacenter: "dc-west", Status: "ready", SchedulingEligibility: "eligible", Drain: false, Meta: { owner: "platform" }, Drivers: { docker: { Detected: true, Healthy: true } }, NodeResources: { Cpu: { CpuShares: 2000 }, Memory: { MemoryMB: 4096 } } };
const pool = { Name: "team", Description: "Original description", Meta: { owner: "platform" }, SchedulerConfiguration: { SchedulerAlgorithm: "spread" } };
const stats = { Memory: { Total: 1024 * 1024 * 100, Used: 1024 * 1024 * 25 }, CPU: [{ CPU: "cpu0", Idle: 60 }], DiskStats: [], Uptime: 123 };
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  client.put.mockResolvedValue({ data: null }); client.post.mockResolvedValue({ data: null }); client.delete.mockResolvedValue({ data: null });
  client.get.mockImplementation(async (path: string) => {
    if (path.endsWith("/dashboard/allocations")) return { data: { items: [{ ID: "alloc-1", Name: "web[0]", Namespace: "default", NodeID: "node-1", ClientStatus: "running" }], nextToken: "alloc-cursor" } };
    if (path.endsWith("/nodes/node-1/stats")) return { data: stats };
    if (path.endsWith("/nodes/node-1/allocations")) return { data: [{ ID: "alloc-1", Name: "web[0]", Namespace: "default", JobID: "web", ClientStatus: "running" }] };
    if (path.endsWith("/nodes/node-1")) return { data: node };
    if (path.endsWith("/nodes")) return { data: { items: [node], nextToken: "node-cursor" } };
    if (path.endsWith("/node-pools/team/jobs")) return { data: { items: [], nextToken: "" } };
    if (path.endsWith("/node-pools/team")) return { data: { ...pool } };
    if (path.endsWith("/node-pools")) return { data: { items: [pool], nextToken: "" } };
    if (path.endsWith("/servers/leader")) return { data: { leader: "10.0.0.1:4647" } };
    if (path.endsWith("/servers/raft")) return { data: { Index: 3, Servers: [{ ID: "raft-1", Node: "server-1", Address: "10.0.0.1:4647", Leader: true, Voter: true, RaftProtocol: "3" }] } };
    if (path.endsWith("/servers")) return { data: [{ Name: "server-1", Addr: "10.0.0.1", Port: 4648, Status: "alive", Tags: { dc: "dc-west" } }] };
    if (path.endsWith("/agent/self")) return { data: { member: { Name: "server-1" }, stats: { raft: { state: "Leader" } } } };
    if (path.endsWith("/agent/metrics")) return { data: { Timestamp: "now", Gauges: [{ Name: "nomad.client.allocated.cpu", Value: 200 }], Counters: [], Samples: [] } };
    throw new Error(`Unexpected path: ${path}`);
  });
});

describe("Cluster native consumers", () => {
  it("renders actual topology and live utilization with allocation links and honest page scope", async () => {
    render(<DashboardPage {...props} />);
    await screen.findByText("Datacenter / pool: dc-west / team");
    await screen.findByText("25.0%");
    expect(screen.getByText(/not cluster-wide totals/)).toBeTruthy();
    expect(screen.getByText("2000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "web[0] / running" }));
    expect(props.onNavigate).toHaveBeenCalledWith("allocations", "alloc-1", "default");
    fireEvent.click(screen.getByRole("button", { name: "Next allocation page" }));
    await waitFor(() => expect(client.get).toHaveBeenCalledWith("/hosts/7/dashboard/allocations", { params: { per_page: "200", next_token: "alloc-cursor", namespace: "default" } }));
  });
  it("requires explicit drain confirmation and preserves the entered deadline during live refresh", async () => {
    const view = (tick: number) => <RefreshContext.Provider value={tick}><NodesPage {...props} selectedId="node-1" /></RefreshContext.Provider>;
    const { rerender } = render(view(0));
    await screen.findByLabelText("Drain deadline seconds");
    fireEvent.change(screen.getByLabelText("Drain deadline seconds"), { target: { value: "120" } });
    rerender(view(1));
    await waitFor(() => expect(client.get.mock.calls.filter(([path]) => path === "/hosts/7/nodes/node-1").length).toBeGreaterThan(1));
    expect((screen.getByLabelText("Drain deadline seconds") as HTMLInputElement).value).toBe("120");
    fireEvent.click(screen.getByRole("button", { name: "Start drain" }));
    expect(client.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Start drain" }));
    await waitFor(() => expect(client.put).toHaveBeenCalledWith("/hosts/7/nodes/node-1/drain", { enabled: true, deadlineSeconds: 120, ignoreSystemJobs: false, markEligible: false }, { params: { namespace: "default" } }));
  });
  it("keeps a dirty pool form through auto-refresh and sends metadata and scheduler settings only after confirmation", async () => {
    const view = (tick: number) => <RefreshContext.Provider value={tick}><NodePoolsPage {...props} selectedId="team" /></RefreshContext.Provider>;
    const { rerender } = render(view(0));
    await screen.findByLabelText("Edit pool description");
    fireEvent.change(screen.getByLabelText("Edit pool description"), { target: { value: "Edited description" } });
    rerender(view(1));
    await waitFor(() => expect(client.get.mock.calls.filter(([path]) => path === "/hosts/7/node-pools/team").length).toBeGreaterThan(1));
    expect((screen.getByLabelText("Edit pool description") as HTMLInputElement).value).toBe("Edited description");
    fireEvent.click(screen.getByRole("button", { name: "Update node pool" })); expect(client.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Update node pool" }));
    await waitFor(() => expect(client.put).toHaveBeenCalledWith("/hosts/7/node-pools/team", expect.objectContaining({ Name: "team", Description: "Edited description", Meta: { owner: "platform" }, SchedulerConfiguration: { SchedulerAlgorithm: "spread" } }), { params: { namespace: "default" } }));
  });
  it("does not offer global mutation controls or server diagnostics to manage-only users", async () => {
    const { unmount } = render(<NodesPage {...props} canAdmin={false} selectedId="node-1" />);
    await screen.findByText("Cluster administration permission is required to change scheduling.");
    expect(screen.queryByRole("button", { name: "Start drain" })).toBeNull(); unmount();
    client.get.mockClear(); render(<ServersPage {...props} canAdmin={false} />);
    expect(screen.getByText("Cluster administration permission is required for server diagnostics.")).toBeTruthy();
    expect(client.get).not.toHaveBeenCalled();
  });
  it("streams logs through authenticated transport without restarting them on live refresh", async () => {
    const transport = { fetch: vi.fn(async () => new Response("authenticated server log\n")) };
    const view = (tick: number) => <ResourceTransportContext.Provider value={transport}><RefreshContext.Provider value={tick}><ServersPage {...props} selectedId="server-1" /></RefreshContext.Provider></ResourceTransportContext.Provider>;
    const { rerender } = render(view(0));
    fireEvent.click(await screen.findByRole("button", { name: "Open monitor" }));
    await screen.findByText("authenticated server log");
    expect(transport.fetch).toHaveBeenCalledWith("/hosts/7/servers/server-1/monitor?level=info&namespace=default", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    rerender(view(1));
    await waitFor(() => expect(client.get.mock.calls.filter(([path]) => path === "/hosts/7/servers").length).toBeGreaterThan(1));
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close monitor" }));
    expect(screen.queryByLabelText("Live output")).toBeNull();
  });
});

describe("Node pool lifecycle consumers", () => {
  it("creates a pool from primary fields without sending an invalid empty TTL", async () => {
    render(<NodePoolsPage {...props} />);
    fireEvent.change(screen.getByLabelText("New pool name"), { target: { value: "batch" } });
    fireEvent.change(screen.getByLabelText("New pool description"), { target: { value: "Batch workers" } });
    fireEvent.click(screen.getByRole("button", { name: "Create node pool" }));
    expect(client.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Create node pool" }));
    await waitFor(() => expect(client.put).toHaveBeenCalledWith("/hosts/7/node-pools", { Name: "batch", Description: "Batch workers", Meta: {}, SchedulerConfiguration: null }, { params: { namespace: "default" } }));
  });
  it("confirms pool deletion before performing the request", async () => {
    render(<NodePoolsPage {...props} selectedId="team" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete node pool" }));
    expect(client.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete node pool" }));
    await waitFor(() => expect(client.delete).toHaveBeenCalledWith("/hosts/7/node-pools/team", { params: { namespace: "default" } }));
    expect(props.onNavigate).toHaveBeenCalledWith("node-pools");
  });
});
