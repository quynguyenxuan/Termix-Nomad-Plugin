import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AllocationsPage } from "../../src/frontend/AllocationPage";
import { ExecTerminal } from "../../src/frontend/ExecTerminal";
import { RefreshContext, type PageProps } from "../../src/frontend/ResourceUI";
import type * as ResourceUIModule from "../../src/frontend/ResourceUI";

const harness = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), fetch: vi.fn(), download: vi.fn(), url: vi.fn() },
  hook: vi.fn(), input: undefined as ((data: string) => void) | undefined,
  dispose: vi.fn(), write: vi.fn(), fit: vi.fn(), inputDispose: vi.fn(), observerDisconnect: vi.fn(),
}));
vi.mock("../../src/frontend/ResourceUI", async importOriginal => ({ ...await importOriginal<typeof ResourceUIModule>(), useResourceApi: (hostId: string, namespace: string) => { harness.hook(hostId, namespace); return harness.api; } }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  rows = 24; cols = 80;
  loadAddon() {} open() {} focus() {}
  dispose = harness.dispose;
  write = (data: Uint8Array, callback: () => void) => { harness.write(data); callback(); };
  onData(callback: (data: string) => void) { harness.input = callback; return { dispose: harness.inputDispose }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = harness.fit; } }));
const allocation = { ID: "alloc", Name: "web.alloc", Namespace: "team", JobID: "job", NodeID: "node", EvalID: "evaluation", DeploymentID: "deployment", ClientStatus: "running", DesiredStatus: "run", TaskStates: { web: { State: "running", Restarts: 1, Events: [{ Time: 1_700_000_000_000_000_000, Type: "Started", DisplayMessage: "Task started", ExitCode: 0 }] }, sidecar: { State: "running" } }, AllocatedResources: { Tasks: { web: { Cpu: { CpuShares: 500 }, Memory: { MemoryMB: 256 } } }, Shared: { DiskMB: 300 } } };
function props(overrides: Partial<PageProps> = {}): PageProps { return { hostId: "7", namespace: "team", selectedId: "alloc", canManage: true, canAdmin: false, canExec: true, onNavigate: vi.fn(), ...overrides }; }
beforeEach(() => {
  vi.clearAllMocks(); harness.input = undefined;
  harness.api.get.mockImplementation(async (path: string) => {
    if (path === "/allocations") return { items: [allocation], nextToken: "" };
    if (path.endsWith("/stats")) return { ResourceUsage: { CpuStats: { Percent: 12 }, MemoryStats: { RSS: 1048576 } } };
    if (path.endsWith("/fs/ls")) return [{ Name: "config.txt", Size: 5, IsDir: false, FileMode: "-rw-------" }];
    if (path.endsWith("/fs/stat")) return { Size: 5, FileMode: "-rw-------", ContentType: "text/plain" };
    if (path.endsWith("/fs/read")) return { text: "hello" };
    return allocation;
  });
  harness.api.post.mockResolvedValue({});
  harness.api.fetch.mockImplementation(async () => new Response("live output"));
  harness.api.download.mockResolvedValue(new Blob(["hello"]));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Allocation management", () => {
  it("renders tasks and events, and confirms each exact restart/stop action", async () => {
    render(<AllocationsPage {...props()} />);
    expect(await screen.findByText("Task started")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart web" }));
    expect(harness.api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Restart web" }));
    await waitFor(() => expect(harness.api.post).toHaveBeenCalledWith("/allocations/alloc/restart", { task: "web" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart all tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Restart all tasks" }));
    await waitFor(() => expect(harness.api.post).toHaveBeenCalledWith("/allocations/alloc/restart", { allTasks: true }));
    fireEvent.click(screen.getByRole("button", { name: "Stop allocation" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Stop allocation" }));
    await waitFor(() => expect(harness.api.post).toHaveBeenCalledWith("/allocations/alloc/stop", undefined));
  });
  it("keeps read-only and wildcard views from issuing destructive/exec actions", async () => {
    const view = render(<AllocationsPage {...props({ canManage: false, canExec: false })} />);
    await screen.findByText("Task started");
    expect(screen.queryByRole("button", { name: "Restart web" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Exec" })).toBeNull();
    view.rerender(<AllocationsPage {...props({ namespace: "*" })} />);
    await screen.findByText("Task started");
    expect((screen.getByRole("button", { name: "Stop allocation" }) as HTMLButtonElement).disabled).toBe(true);
    expect(harness.api.post).not.toHaveBeenCalled();
  });
  it("preserves allocation namespace in cross-resource navigation and task selection through refresh", async () => {
    const properties = props();
    const view = render(<RefreshContext.Provider value={0}><AllocationsPage {...properties} /></RefreshContext.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: "Job: job" }));
    expect(properties.onNavigate).toHaveBeenCalledWith("jobs", "job", "team");
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    fireEvent.change(screen.getByLabelText("Allocation task"), { target: { value: "sidecar" } });
    fireEvent.change(screen.getByLabelText("Log stream"), { target: { value: "stderr" } });
    await waitFor(() => expect(harness.api.fetch).toHaveBeenCalledWith("/allocations/alloc/logs/stream", { task: "sidecar", type: "stderr" }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    const requests = harness.api.fetch.mock.calls.length;
    view.rerender(<RefreshContext.Provider value={1}><AllocationsPage {...properties} /></RefreshContext.Provider>);
    await waitFor(() => expect(harness.api.get.mock.calls.filter(([path]) => path === "/allocations/alloc").length).toBe(2));
    expect((screen.getByLabelText("Allocation task") as HTMLSelectElement).value).toBe("sidecar");
    expect(harness.api.fetch.mock.calls.length).toBe(requests);
    const signal = harness.api.fetch.mock.calls.at(-1)![2].signal as AbortSignal;
    view.unmount(); expect(signal.aborted).toBe(true);
  });
  it("shows resource usage and uses authenticated file stat/read/download methods", async () => {
    vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:download"); static revokeObjectURL = vi.fn(); });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AllocationsPage {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resources" }));
    expect(screen.getByText("Memory RSS: 1.00 MiB / Cache: -")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    fireEvent.click(await screen.findByRole("button", { name: "config.txt" }));
    expect(await screen.findByText("hello")).toBeTruthy();
    expect(harness.api.get).toHaveBeenCalledWith("/allocations/alloc/fs/stat", { path: "config.txt" });
    expect(harness.api.get).toHaveBeenCalledWith("/allocations/alloc/fs/read", { path: "config.txt", offset: "0", limit: "65536" });
    fireEvent.click(screen.getByRole("button", { name: "Download file" }));
    await waitFor(() => expect(harness.api.download).toHaveBeenCalledWith("/allocations/alloc/fs/download", { path: "config.txt" }));
  });
});

class BrowserSocket {
  static OPEN = 1;
  static instances: BrowserSocket[] = [];
  readyState = 1; bufferedAmount = 0;
  onmessage: ((event: { data: string }) => void) | undefined;
  onclose: ((event: { reason: string }) => void) | undefined;
  onerror: (() => void) | undefined;
  send = vi.fn();
  close = vi.fn((_code?: number, reason = "") => { this.readyState = 3; this.onclose?.({ reason }); });
  constructor(public url: string, public protocols?: string[]) { BrowserSocket.instances.push(this); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function terminalSetup() {
  BrowserSocket.instances = [];
  vi.stubGlobal("WebSocket", BrowserSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect = harness.observerDisconnect; });
  const socketUrl = vi.fn(async (_path: string) => ({ url: "wss://termix.test/socket", protocols: ["authenticated-ticket"] }));
  return { socketUrl, properties: { hostId: "7", namespace: "team", allocationId: "alloc", task: "web", socketUrl } };
}
describe("Interactive xterm allocation exec", () => {
  it("validates argv before authentication and refuses wildcard namespaces", async () => {
    const { socketUrl, properties } = terminalSetup();
    const view = render(<ExecTerminal {...properties} />);
    fireEvent.change(screen.getByLabelText("Exec command arguments"), { target: { value: "sh -c whoami" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect terminal" }));
    expect(await screen.findByRole("alert")).toBeTruthy(); expect(socketUrl).not.toHaveBeenCalled();
    view.rerender(<ExecTerminal {...properties} namespace="*" />);
    expect((screen.getByRole("button", { name: "Connect terminal" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("uses ticketed socket, base64 stdin/stdout and resize, without reopening on rerender, and cleans up", async () => {
    const { socketUrl, properties } = terminalSetup();
    const view = render(<ExecTerminal {...properties} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect terminal" }));
    await waitFor(() => expect(BrowserSocket.instances).toHaveLength(1));
    const socket = BrowserSocket.instances[0]!;
    expect(socket.protocols).toEqual(["authenticated-ticket"]);
    expect(new URL(socketUrl.mock.calls[0]![0]!, "https://termix.test").searchParams.get("command")).toBe('["/bin/sh"]');
    act(() => socket.message({ ready: true }));
    expect(socket.send).toHaveBeenCalledWith('{"tty_size":{"height":24,"width":80}}');
    act(() => harness.input?.("hello"));
    expect(socket.send).toHaveBeenCalledWith('{"stdin":{"data":"aGVsbG8="}}');
    act(() => socket.message({ stdout: { data: "aGk=" } }));
    expect(Array.from(harness.write.mock.calls[0]![0])).toEqual([104, 105]);
    view.rerender(<ExecTerminal {...properties} />);
    expect(socketUrl).toHaveBeenCalledTimes(1);
    act(() => socket.message({ exited: true, result: { exit_code: 7 } }));
    expect(screen.getByRole("status").textContent).toBe("Exited (7)");
    view.unmount();
    expect(socket.close).toHaveBeenCalled(); expect(harness.dispose).toHaveBeenCalledTimes(1);
    expect(harness.inputDispose).toHaveBeenCalledTimes(1); expect(harness.observerDisconnect).toHaveBeenCalledTimes(1);
  });
  it("cancels a pending authenticated connection on explicit disconnect", async () => {
    const { properties, socketUrl } = terminalSetup();
    let resolve!: (target: { url: string; protocols: string[] }) => void;
    socketUrl.mockImplementation(() => new Promise(done => { resolve = done; }));
    render(<ExecTerminal {...properties} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect terminal" }));
    await waitFor(() => expect(socketUrl).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect terminal" }));
    await act(async () => { resolve({ url: "wss://termix.test/socket", protocols: [] }); });
    expect(BrowserSocket.instances).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("Disconnected");
  });
});
