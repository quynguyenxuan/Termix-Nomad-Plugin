import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JobsPage, DeploymentsPage, EvaluationsPage } from "../../src/frontend/JobsPage";
import { JobOperations } from "../../src/frontend/JobOperations";
import { JobTemplates } from "../../src/frontend/JobOperationsTemplates";
import { RefreshContext, useResourceApi, type PageProps } from "../../src/frontend/ResourceUI";

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({ usePluginApi: () => client }));
const props: PageProps = { hostId: "7", namespace: "default", canManage: true, canAdmin: false, canExec: false, onNavigate: vi.fn() };
const job = { ID: "web", Namespace: "default", Version: 3, Status: "running", Type: "service", JobModifyIndex: 52, Periodic: { Spec: "0 * * * *", TimeZone: "UTC" }, ParameterizedJob: { Payload: "optional", MetaRequired: ["owner"], MetaOptional: ["region"] }, TaskGroups: [{ Name: "web", Count: 2, Services: [{ Name: "web-http", Provider: "nomad", PortLabel: "http" }], Tasks: [{ Name: "server", Driver: "docker", Resources: { CPU: 500, MemoryMB: 128 }, Constraints: [{ LTarget: "${attr.kernel.name}", Operand: "=", RTarget: "linux" }] }] }] };
const template = { Path: "nomad/job-templates/web", Namespace: "default", ModifyIndex: 4, Items: { template: 'job "web" {}', description: "A web job", retained: "keep me" } };
const deployment = { ID: "rollout", Namespace: "default", JobID: "web", Status: "running", JobVersion: 3, TaskGroups: { web: { DesiredTotal: 2, HealthyAllocs: 1, DesiredCanaries: 1, PlacedCanaries: ["canary"], Promoted: false } } };
const evaluation = { ID: "eval", Namespace: "default", JobID: "web", Status: "blocked", TriggeredBy: "job-register", DeploymentID: "rollout", NodeID: "node", NextEval: "next", QueuedAllocations: { web: 1 }, FailedTGAllocs: { web: { NodesEvaluated: 3, NodesFiltered: 2, ConstraintFiltered: { "missing driver": 2 } } }, RelatedEvals: [{ ID: "related", Status: "complete" }] };
function Operations({ canManage = true }: { canManage?: boolean }) {
  const api = useResourceApi("7", "default");
  return <JobOperations api={api} jobId="web" canManage={canManage} onNavigate={props.onNavigate} onChanged={() => {}} />;
}
function Templates({ canManage = true, onLoad = vi.fn() }: { canManage?: boolean; onLoad?: (source: string) => void }) {
  const api = useResourceApi("7", "default");
  return <JobTemplates api={api} source={'job "updated" {}'} format="hcl" canManage={canManage} onLoad={onLoad} />;
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  client.post.mockResolvedValue({ data: { EvalID: "new-eval", DispatchedJobID: "web/dispatch-1" } });
  client.put.mockImplementation(async (_path: string, body: Record<string, unknown>) => ({ data: { ...body, Namespace: "default", ModifyIndex: 8 } }));
  client.delete.mockResolvedValue({ data: null });
  client.get.mockImplementation(async (url: string) => {
    const path = new URL(url, "http://plugin").pathname;
    if (path.endsWith("/job-list")) return { data: { items: [job], nextToken: "jobs-next" } };
    if (path.endsWith("/jobs/web/versions")) return { data: { Versions: [{ ...job }, { ...job, Version: 2 }], Diffs: [{ ID: "web", Type: "Edited", Fields: [{ Name: "Count", Old: "1", New: "2" }] }] } };
    if (path.endsWith("/jobs/web/deployments")) return { data: [deployment] };
    if (path.endsWith("/jobs/web/evaluations")) return { data: [evaluation] };
    if (path.endsWith("/jobs/web/allocations")) return { data: [{ ID: "alloc", Name: "web[0]", Namespace: "default", JobID: "web", TaskGroup: "web", ClientStatus: "running" }] };
    if (path.endsWith("/jobs/web")) return { data: { ...job } };
    if (path.endsWith("/deployments/rollout/allocations") || path.endsWith("/evaluations/eval/allocations")) return { data: [{ ID: "alloc", Namespace: "default", ClientStatus: "running" }] };
    if (path.endsWith("/deployments/rollout")) return { data: deployment };
    if (path.endsWith("/evaluations/eval")) return { data: evaluation };
    if (path.endsWith("/deployments")) return { data: { items: [deployment], nextToken: "" } };
    if (path.endsWith("/evaluations")) return { data: { items: [evaluation], nextToken: "" } };
    if (path.endsWith("/variables")) return { data: { items: [{ Path: template.Path, Namespace: "default", ModifyIndex: 4 }], nextToken: "" } };
    if (path.endsWith("/variable")) return { data: { ...template, Items: { ...template.Items } } };
    throw new Error(`Unexpected path: ${path}`);
  });
});

describe("Native jobs workflows", () => {
  it("reads versions and readable differences and only reverts after guarded confirmation", async () => {
    render(<Operations />);
    await screen.findByText("Count");
    fireEvent.change(screen.getByLabelText("Diff baseline"), { target: { value: "2" } });
    await waitFor(() => expect(client.get).toHaveBeenCalledWith("/hosts/7/jobs/web/versions", { params: { namespace: "default", diff_version: "2" } }));
    fireEvent.change(screen.getByLabelText("Revert version"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Revert job" }));
    expect(client.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Revert job" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith("/hosts/7/jobs/web/revert", { version: 2, enforcePriorVersion: 3 }, { params: { namespace: "default" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Evaluation new-eval" }));
    expect(props.onNavigate).toHaveBeenCalledWith("evaluations", "new-eval");
  });

  it("preserves dirty dispatch input on live refresh and confirms lifecycle writes", async () => {
    const view = (tick: number) => <RefreshContext.Provider value={tick}><Operations /></RefreshContext.Provider>;
    const { rerender } = render(view(0));
    fireEvent.change(await screen.findByLabelText("Metadata owner"), { target: { value: "platform" } });
    fireEvent.change(screen.getByLabelText("Dispatch payload"), { target: { value: "payload text" } });
    rerender(view(1));
    await waitFor(() => expect(client.get.mock.calls.filter(([path]) => path === "/hosts/7/jobs/web").length).toBeGreaterThan(1));
    expect((screen.getByLabelText("Dispatch payload") as HTMLTextAreaElement).value).toBe("payload text");
    fireEvent.click(screen.getByRole("button", { name: "Dispatch job" }));
    expect(client.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Dispatch job" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith("/hosts/7/jobs/web/dispatch", { meta: { owner: "platform" }, payload: "payload text", idPrefix: "" }, { params: { namespace: "default" } }));
    for (const [label, action] of [["Evaluate job", "evaluate"], ["Force periodic run", "periodic-force"], ["Purge job", "purge"]]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      fireEvent.click(screen.getByRole("button", { name: `Confirm ${label}` }));
      await waitFor(() => expect(client.post).toHaveBeenCalledWith(`/hosts/7/jobs/web/${action}`, action === "evaluate" ? { forceReschedule: false } : {}, { params: { namespace: "default" } }));
    }
  });

  it("keeps read-only versions and links while hiding lifecycle write controls", async () => {
    render(<Operations canManage={false} />);
    await screen.findByText("Count");
    expect(screen.queryByRole("button", { name: "Revert job" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Purge job" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "rollout / running / version 3" }));
    expect(props.onNavigate).toHaveBeenCalledWith("deployments", "rollout");
  });

  it("pages jobs and navigates allocation, service and variable links in the concrete scope", async () => {
    const view = (tick: number) => <RefreshContext.Provider value={tick}><JobsPage {...props} selectedId="web" /></RefreshContext.Provider>;
    const { rerender } = render(view(0));
    fireEvent.change(await screen.findByLabelText("Count for web"), { target: { value: "9" } });
    rerender(view(1));
    await waitFor(() => expect(client.get.mock.calls.filter(([path]) => new URL(path, "http://plugin").pathname === "/hosts/7/jobs/web").length).toBeGreaterThan(2));
    expect((screen.getByLabelText("Count for web") as HTMLInputElement).value).toBe("9");
    expect(screen.getByText("CPU 500 MHz / memory 128 MiB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "web[0] / web / running" }));
    expect(props.onNavigate).toHaveBeenCalledWith("allocations", "alloc", "default");
    fireEvent.click(screen.getByRole("button", { name: "web-http / nomad / port http" }));
    expect(props.onNavigate).toHaveBeenCalledWith("services", "web-http", "default");
    fireEvent.click(screen.getByRole("button", { name: "Job variables" }));
    expect(props.onNavigate).toHaveBeenCalledWith("variables", "nomad/jobs/web", "default");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(client.get).toHaveBeenCalledWith("/hosts/7/job-list", { params: { namespace: "default", next_token: "jobs-next", per_page: 50 } }));
  });

  it("carries a wildcard row namespace into detail navigation", async () => {
    client.get.mockResolvedValue({ data: { items: [{ ...job, Namespace: "team" }], nextToken: "" } });
    render(<JobsPage {...props} namespace="*" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open web" }));
    expect(props.onNavigate).toHaveBeenCalledWith("jobs", "web", "team");
    expect((screen.getByRole("button", { name: "Run job" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders rollout health and confirms all deployment control paths", async () => {
    render(<DeploymentsPage {...props} selectedId="rollout" />);
    fireEvent.click(await screen.findByRole("button", { name: "Canary canary" }));
    expect(props.onNavigate).toHaveBeenCalledWith("allocations", "canary", "default");
    fireEvent.click(screen.getByLabelText("web", { selector: "input" }));
    for (const [label, action] of [["Promote", "promote"], ["Fail", "fail"], ["Pause", "pause"], ["Resume", "resume"], ["Unblock", "unblock"]]) {
      fireEvent.click(screen.getByRole("button", { name: `${label} deployment` }));
      expect(client.post.mock.calls.filter(([path]) => path === `/hosts/7/deployments/rollout/${action}`)).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: `Confirm ${label} deployment` }));
      await waitFor(() => expect(client.post).toHaveBeenCalledWith(`/hosts/7/deployments/rollout/${action}`, action === "promote" ? { groups: ["web"] } : {}, { params: { namespace: "default" } }));
    }
  });

  it("renders evaluation placement metrics and navigates related evaluations", async () => {
    render(<EvaluationsPage {...props} selectedId="eval" />);
    await screen.findByText("missing driver: 2");
    expect(screen.getByText("Nodes evaluated: 3 / exhausted: 0 / filtered: 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "related / complete" }));
    expect(props.onNavigate).toHaveBeenCalledWith("evaluations", "related", "default");
    fireEvent.click(screen.getByRole("button", { name: "NextEval: next" }));
    expect(props.onNavigate).toHaveBeenCalledWith("evaluations", "next", "default");
  });
});

describe("Nomad job templates", () => {
  it("lists metadata only, explicitly reads source and preserves unrelated items with CAS", async () => {
    const onLoad = vi.fn();
    render(<Templates onLoad={onLoad} />);
    const row = await screen.findByRole("button", { name: `Open ${template.Path}` });
    expect(client.get.mock.calls.some(([path]) => path === "/hosts/7/variable")).toBe(false);
    expect(client.get).toHaveBeenCalledWith("/hosts/7/variables", { params: { namespace: "default", prefix: "nomad/job-templates/", next_token: "", per_page: 50 } });
    fireEvent.click(row);
    fireEvent.click(await screen.findByRole("button", { name: "Load template into editor" }));
    expect(onLoad).toHaveBeenCalledWith(template.Items.template);
    fireEvent.change(screen.getByLabelText("Template description"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Update selected template" }));
    expect(client.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Update selected template" }));
    await screen.findByText("Template updated.");
    await waitFor(() => expect(client.put).toHaveBeenCalledWith("/hosts/7/variable", { Path: template.Path, Items: { ...template.Items, template: 'job "updated" {}', description: "Updated" }, ModifyIndex: 4 }, { params: { namespace: "default" } }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected template" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete selected template" }));
    await waitFor(() => expect(client.delete).toHaveBeenCalledWith("/hosts/7/variable", { params: { namespace: "default", path: template.Path, cas: 8 } }));
  });

  it("creates templates with CAS zero and surfaces ACL or server failures", async () => {
    render(<Templates />);
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new template" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Save as new template" }));
    await waitFor(() => expect(client.put).toHaveBeenCalledWith("/hosts/7/variable", { Path: "nomad/job-templates/new", Items: { template: 'job "updated" {}', description: "" }, ModifyIndex: 0 }, { params: { namespace: "default" } }));
    await screen.findByText("Template created.");
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh list" }) as HTMLButtonElement).disabled).toBe(false));
    client.get.mockRejectedValue(new Error("Nomad ACL denied variables"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh list" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Nomad ACL denied variables"));
  });
});
