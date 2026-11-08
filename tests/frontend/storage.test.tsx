import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ServicesPage, VariablesPage, VolumesPage } from "../../src/frontend/StoragePages";
import { RefreshContext, type PageProps } from "../../src/frontend/ResourceUI";

const client = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({ usePluginApi: () => client }));
const props: PageProps = { hostId: "7", namespace: "default", canManage: true, canAdmin: false, canExec: false, onNavigate: vi.fn() };
const volume = { ID: "disk", Name: "Database", Namespace: "default", PluginID: "provider", ExternalID: "external-disk", Capacity: 100, Allocations: [{ ID: "alloc", Name: "web[0]", Namespace: "default", ClientStatus: "running" }] };
let variable = { Path: "apps/web", Namespace: "default", Items: { token: "original-value" }, ModifyIndex: 7 };
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); variable = { Path: "apps/web", Namespace: "default", Items: { token: "original-value" }, ModifyIndex: 7 };
  client.put.mockImplementation(async (_path: string, body: Record<string, unknown>) => ({ data: { ...body, Namespace: "default", ModifyIndex: 9 } }));
  client.delete.mockResolvedValue({ data: null });
  client.post.mockImplementation(async (path: string) => ({ data: path.endsWith("/snapshots/list") ? { items: [{ ID: "snap", ExternalSourceVolumeID: "external-disk", IsReady: true }], nextToken: "page-2" } : null }));
  client.get.mockImplementation(async (path: string) => {
    if (path.endsWith("/services/web/instance/checks")) return { data: { health: { Service: "web", Check: "HTTP readiness", Status: "success", Output: "OK" } } };
    if (path.endsWith("/services/web")) return { data: [{ ID: "instance", ServiceName: "web", Namespace: "default", JobID: "web", AllocID: "alloc", NodeID: "node", Address: "10.1.0.2", Port: 8080 }] };
    if (path.endsWith("/services")) return { data: [{ ServiceName: "web", Namespace: "default", Tags: ["public"] }] };
    if (path.endsWith("/csi-volumes/disk") || path.endsWith("/host-volumes/disk")) return { data: volume };
    if (path.endsWith("/csi-plugins/provider")) return { data: { ID: "provider", Provider: "Real driver", Version: "1.2", ControllersHealthy: 1, ControllersExpected: 1, NodesHealthy: 2, NodesExpected: 2, Nodes: { node: { Healthy: true, HealthDescription: "Healthy driver" } } } };
    if (path.endsWith("/csi-plugins")) return { data: { items: [{ ID: "provider", Provider: "Real driver" }], nextToken: "" } };
    if (path.endsWith("/csi-volumes") || path.endsWith("/host-volumes")) return { data: { items: [volume], nextToken: "" } };
    if (path.endsWith("/variables")) return { data: { items: [{ Path: variable.Path, Namespace: variable.Namespace, ModifyIndex: variable.ModifyIndex }], nextToken: "" } };
    if (path.endsWith("/variable")) return { data: { ...variable } };
    throw new Error(`Unexpected path: ${path}`);
  });
});

describe("Services and storage native forms", () => {
  it("renders registration detail, loads checks explicitly and confirms deregistration", async () => {
    render(<ServicesPage {...props} selectedId="web" />);
    await screen.findByRole("button", { name: "JobID: web" });
    fireEvent.click(screen.getByRole("button", { name: "AllocID: alloc" })); expect(props.onNavigate).toHaveBeenCalledWith("allocations", "alloc", "default");
    expect(client.get.mock.calls.some(([path]) => String(path).endsWith("/checks"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Load health checks" })); await screen.findByText("HTTP readiness");
    fireEvent.click(screen.getByRole("button", { name: "Deregister instance" })); expect(client.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Deregister instance" }));
    await waitFor(() => expect(client.delete).toHaveBeenCalledWith("/hosts/7/services/web/instance", { params: { namespace: "default" } }));
  });
  it("creates CSI storage with readable fields and provider specifications", async () => {
    render(<VolumesPage {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Create or register volume" }));
    fireEvent.change(screen.getByLabelText("Volume name"), { target: { value: "Database" } });
    fireEvent.change(screen.getByLabelText("Volume ID"), { target: { value: "db" } });
    fireEvent.change(screen.getByLabelText("Plugin ID"), { target: { value: "provider" } });
    fireEvent.change(screen.getByLabelText("Minimum capacity (bytes)"), { target: { value: "1024" } });
    fireEvent.change(screen.getByLabelText("Advanced volume fields (JSON)"), { target: { value: '{"Parameters":{"tier":"ssd"}}' } });
    fireEvent.click(screen.getByRole("button", { name: "Create volume" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith("/hosts/7/csi-volumes/create", { Volume: expect.objectContaining({ ID: "db", Name: "Database", PluginID: "provider", RequestedCapacityMin: 1024, Parameters: { tier: "ssd" }, RequestedCapabilities: [{ AttachmentMode: "file-system", AccessMode: "single-node-writer" }] }) }, { params: { namespace: "default" } }));
  });
  it("registers existing client paths through dynamic host volume fields", async () => {
    render(<VolumesPage {...props} />); fireEvent.click(screen.getByRole("button", { name: "Dynamic host volumes" })); fireEvent.click(screen.getByRole("button", { name: "Create or register volume" }));
    fireEvent.change(screen.getByLabelText("Volume operation"), { target: { value: "register" } });
    fireEvent.change(screen.getByLabelText("Volume name"), { target: { value: "Local data" } });
    fireEvent.change(screen.getByLabelText("Node ID"), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("Host path"), { target: { value: "/mnt/data" } });
    fireEvent.click(screen.getByRole("button", { name: "Register volume" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith("/hosts/7/host-volumes/register", { Volume: expect.objectContaining({ Name: "Local data", NodeID: "node", HostPath: "/mnt/data" }) }, { params: { namespace: "default" } }));
  });
  it("inspects plugin health and preserves volume namespace in allocation navigation", async () => {
    const { unmount } = render(<VolumesPage {...props} selectedId="plugin:provider" />); await screen.findByText("Healthy driver"); fireEvent.click(screen.getByRole("button", { name: "node" })); expect(props.onNavigate).toHaveBeenCalledWith("nodes", "node", "default"); unmount();
    render(<VolumesPage {...props} selectedId="csi:disk" />); fireEvent.click(await screen.findByRole("button", { name: "web[0]: running" })); expect(props.onNavigate).toHaveBeenCalledWith("allocations", "alloc", "default");
  });
  it("keeps deregistration separate from provider deletion and confirms destructive actions", async () => {
    render(<VolumesPage {...props} selectedId="csi:disk" />); await screen.findByRole("button", { name: "Deregister volume" });
    fireEvent.click(screen.getByRole("button", { name: "Delete provider volume" }));
    expect(client.post.mock.calls.some(([path]) => String(path).endsWith("/delete"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete provider volume" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith("/hosts/7/csi-volumes/disk/delete", { Secrets: {} }, { params: { namespace: "default" } })); expect(client.delete).not.toHaveBeenCalled();
  });
  it("lists private snapshots using body credentials and cursor state, not URL secrets", async () => {
    render(<VolumesPage {...props} selectedId="csi:disk" />); await screen.findByRole("button", { name: "Next snapshots" });
    fireEvent.change(screen.getByLabelText("Snapshot parameters and secrets (JSON)"), { target: { value: '{"Secrets":{"api":"private-key"}}' } });
    fireEvent.click(screen.getByRole("button", { name: "Apply snapshot listing credentials" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith("/hosts/7/csi-volumes/disk/snapshots/list", { nextToken: "", Secrets: { api: "private-key" } }, { params: { namespace: "default" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Next snapshots" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith("/hosts/7/csi-volumes/disk/snapshots/list", { nextToken: "page-2", Secrets: { api: "private-key" } }, { params: { namespace: "default" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete snapshot snap" })); fireEvent.click(screen.getByRole("button", { name: "Confirm Delete snapshot snap" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith("/hosts/7/csi-volumes/disk/snapshots/delete", { ID: "snap", nextToken: "page-2", Secrets: { api: "private-key" } }, { params: { namespace: "default" } }));
  });
  it("disables mutations for read-only users", async () => {
    render(<VolumesPage {...props} canManage={false} selectedId="csi:disk" />);
    expect((await screen.findByRole("button", { name: "Deregister volume" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Expand volume" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create or register volume" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Variables native item editor", () => {
  it("browses metadata without reading sensitive Items and supports the upstream template prefix", async () => {
    render(<VariablesPage {...props} />); await screen.findByRole("button", { name: /apps\/web/ });
    expect(client.get.mock.calls.some(([path]) => String(path).endsWith("/variable"))).toBe(false); expect(screen.queryByText("original-value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Job templates" }));
    await waitFor(() => expect(client.get).toHaveBeenCalledWith("/hosts/7/variables", { params: expect.objectContaining({ namespace: "default", prefix: "nomad/job-templates/" }) }));
  });
  it("keeps dirty items and their CAS revision through refresh, and exposes conflicts without overwriting", async () => {
    const view = (tick: number) => <RefreshContext.Provider value={tick}><VariablesPage {...props} selectedId="apps/web" /></RefreshContext.Provider>;
    const { rerender } = render(view(0)); await screen.findByLabelText("Item value 1");
    fireEvent.change(screen.getByLabelText("Item value 1"), { target: { value: "edited-value" } });
    variable = { ...variable, ModifyIndex: 8, Items: { token: "new-server-value" } }; rerender(view(1));
    await screen.findByText(/This variable changed on the server/); expect((screen.getByLabelText("Item value 1") as HTMLTextAreaElement).value).toBe("edited-value");
    client.put.mockRejectedValueOnce(new Error("CAS conflict")); fireEvent.click(screen.getByRole("button", { name: "Save variable with CAS" }));
    await screen.findByText("CAS conflict"); expect(client.put).toHaveBeenCalledWith("/hosts/7/variable", { Path: "apps/web", Items: { token: "edited-value" }, ModifyIndex: 7 }, { params: { namespace: "default" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete variable" })); expect(client.delete).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Confirm Delete variable" }));
    await waitFor(() => expect(client.delete).toHaveBeenCalledWith("/hosts/7/variable", { params: { namespace: "default", path: "apps/web", cas: "7" } }));
  });
  it("creates variables with CAS zero and rejects duplicate item keys", async () => {
    render(<VariablesPage {...props} />); fireEvent.click(screen.getByRole("button", { name: "Create variable" }));
    fireEvent.change(screen.getByLabelText("Variable path"), { target: { value: "nomad/job-templates/web" } });
    fireEvent.change(screen.getByLabelText("Item key 1"), { target: { value: "template" } }); fireEvent.change(screen.getByLabelText("Item value 1"), { target: { value: 'job "web" {}' } });
    fireEvent.click(screen.getByRole("button", { name: "Add item" })); fireEvent.change(screen.getByLabelText("Item key 2"), { target: { value: "template" } }); fireEvent.click(screen.getByRole("button", { name: "Save variable with CAS" }));
    await screen.findByText("Provide at least one item with a nonempty, unique key."); expect(client.put).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Item key 2"), { target: { value: "description" } }); fireEvent.change(screen.getByLabelText("Item value 2"), { target: { value: "Web service" } }); fireEvent.click(screen.getByRole("button", { name: "Save variable with CAS" }));
    await waitFor(() => expect(client.put).toHaveBeenCalledWith("/hosts/7/variable", { Path: "nomad/job-templates/web", Items: { template: 'job "web" {}', description: "Web service" }, ModifyIndex: 0 }, { params: { namespace: "default" } }));
  });
});
