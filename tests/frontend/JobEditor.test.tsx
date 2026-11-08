import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JobEditor } from "../../src/frontend/JobEditor";
import type { Format, Job, JobConsulStatus, JobSubmission, JobValidation, NomadApi, PlanResult } from "../../src/frontend/nomad-api";

vi.mock("../../src/frontend/JobSourceEditor", () => ({
  JobSourceEditor: ({ label, value, onChange, readOnly }: { label: string; value: string; onChange(value: string): void; readOnly?: boolean }) => <textarea aria-label={label} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} />,
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const job: Job = { ID: "web", Namespace: "default", TaskGroups: [{ Name: "web", Count: 1 }] };
const valid: JobValidation = { DriverConfigValidated: true, ValidationErrors: [], Error: "", Warnings: "" };
function apiStub() {
  return {
    parse: vi.fn(async (_source: string, _format: Format, _variables?: string) => ({ ...job })),
    validate: vi.fn(async (_job: Job): Promise<JobValidation> => ({ ...valid })),
    submission: vi.fn(async (_jobId: string, _version: number): Promise<JobSubmission | null> => null),
    plan: vi.fn(async (_job: Job): Promise<PlanResult> => ({ JobModifyIndex: 17, Diff: { Type: "Edited" }, FailedTGAllocs: {} })),
    deploy: vi.fn(async (_job: Job, _modifyIndex: number, _submission?: JobSubmission) => ({})),
    status: vi.fn(async () => ({ leader: "127.0.0.1:4647" })),
    namespaces: vi.fn(async () => []), jobs: vi.fn(async () => []), nodes: vi.fn(async () => []),
    job: vi.fn(async () => job), allocations: vi.fn(async () => []), allocation: vi.fn(async () => ({ ID: "alloc" })),
    jobConsul: vi.fn(async (): Promise<JobConsulStatus> => ({ configured: false, status: "unconfigured", usesConsul: false, health: "not-applicable", checks: [], expectedServices: 0, partial: false })),
    logs: vi.fn(async () => ""), scale: vi.fn(async () => ({})), stop: vi.fn(async () => ({})),
  } satisfies NomadApi;
}
function changeSource(value = 'job "web" {}') {
  fireEvent.change(screen.getByLabelText("Job source"), { target: { value } });
}
async function planJob() {
  changeSource();
  fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
  await screen.findByRole("button", { name: "Deploy planned job" });
}

describe("Nomad job editor", () => {
  it("deploys the exact validated and planned object with source and CAS only after explicit deployment", async () => {
    const api = apiStub();
    const onDeployed = vi.fn();
    render(<JobEditor api={api} namespace="default" canManage onDeployed={onDeployed} />);
    await planJob();
    expect(api.deploy).not.toHaveBeenCalled();
    const planned = api.plan.mock.calls[0][0];
    expect(api.validate).toHaveBeenCalledWith(planned);
    fireEvent.click(screen.getByRole("button", { name: "Deploy planned job" }));
    await waitFor(() => expect(api.deploy).toHaveBeenCalledWith(planned, 17, { Source: 'job "web" {}', Format: "hcl2", Variables: "" }));
    expect(api.deploy.mock.calls[0][0]).toBe(planned);
    expect(onDeployed).toHaveBeenCalledWith(planned);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Submitted job web.");
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
  });

  it("validates without planning and shows canonical configuration, warnings and unchecked driver config honestly", async () => {
    const api = apiStub();
    api.validate.mockResolvedValue({ ...valid, DriverConfigValidated: false, Warnings: "Driver unavailable on this server" });
    api.parse.mockResolvedValue({ ...job, Multiregion: { Strategy: { MaxParallel: 1 } }, Meta: { owner: "ops" } });
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    changeSource();
    fireEvent.click(screen.getByRole("button", { name: "Validate job" }));
    await screen.findByRole("region", { name: "Job validation" });
    expect(screen.getByText(/Driver configuration was not validated/)).toBeTruthy();
    expect(screen.getByText(/Validation warnings: Driver unavailable/)).toBeTruthy();
    expect(screen.getByText(/"MaxParallel": 1/)).toBeTruthy();
    expect(api.plan).not.toHaveBeenCalled();
    expect(api.deploy).not.toHaveBeenCalled();
  });

  it("blocks planning and deployment on semantic validation errors", async () => {
    const api = apiStub();
    api.validate.mockResolvedValue({ ...valid, Error: "Job validation failed", ValidationErrors: ["Task group web has no tasks"] });
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    changeSource();
    fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
    await screen.findByText("Task group web has no tasks");
    expect(screen.getByText(/Configuration validation failed/)).toBeTruthy();
    expect(api.plan).not.toHaveBeenCalled();
    expect(api.deploy).not.toHaveBeenCalled();
  });

  it("keeps actionable syntax diagnostics and the failing source", async () => {
    const api = apiStub();
    api.parse.mockRejectedValue(new Error("job.nomad:4,3: Missing attribute value"));
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    changeSource("invalid HCL");
    fireEvent.click(screen.getByRole("button", { name: "Validate job" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Source parsing failed: job.nomad:4,3"));
    expect((screen.getByLabelText("Job source") as HTMLTextAreaElement).value).toBe("invalid HCL");
    expect(api.validate).not.toHaveBeenCalled();
  });

  it("invalidates a plan on source, variable, or format edits", async () => {
    const api = apiStub();
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    await planJob();
    changeSource('job "other" {}');
    expect(screen.queryByRole("region", { name: "Job validation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
    await screen.findByRole("button", { name: "Deploy planned job" });
    fireEvent.change(screen.getByLabelText("HCL variable values"), { target: { value: 'image = "nginx"' } });
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
    await screen.findByRole("button", { name: "Deploy planned job" });
    expect(api.parse).toHaveBeenLastCalledWith('job "other" {}', "hcl", 'image = "nginx"');
    fireEvent.change(screen.getByLabelText("Job format"), { target: { value: "json" } });
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    expect(api.deploy).not.toHaveBeenCalled();
  });

  it("discards an in-flight plan if the source changes", async () => {
    const api = apiStub();
    const pending = Promise.withResolvers<PlanResult>();
    api.plan.mockReturnValue(pending.promise);
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    changeSource("first");
    fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
    await waitFor(() => expect(api.plan).toHaveBeenCalled());
    changeSource("second");
    await act(async () => { pending.resolve({ JobModifyIndex: 4 }); });
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Job validation" })).toBeNull();
  });

  it("ignores stale validation and does not let its completion clear a newer pending action", async () => {
    const api = apiStub();
    const first = Promise.withResolvers<JobValidation>();
    const second = Promise.withResolvers<JobValidation>();
    api.validate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    changeSource("first");
    fireEvent.click(screen.getByRole("button", { name: "Validate job" }));
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1));
    changeSource("second");
    fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(2));
    await act(async () => { first.resolve({ ...valid, Error: "stale error" }); });
    expect(screen.queryByText("stale error")).toBeNull();
    expect((screen.getByRole("button", { name: "Plan job" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { second.resolve(valid); });
    await screen.findByRole("button", { name: "Deploy planned job" });
  });

  it("allows read-only planning but not deployment", async () => {
    const api = apiStub();
    render(<JobEditor api={api} namespace="default" canManage={false} onDeployed={() => {}} />);
    await planJob();
    expect((screen.getByRole("button", { name: "Deploy planned job" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.deploy).not.toHaveBeenCalled();
  });

  it("blocks unsafe modification indices and namespace mismatches", async () => {
    const api = apiStub();
    api.plan.mockResolvedValue({ JobModifyIndex: Number.MAX_SAFE_INTEGER + 1 });
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    changeSource("source");
    fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("unsafe job modification index"));
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    api.parse.mockResolvedValue({ ...job, Namespace: "private" });
    fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("namespace must match"));
    expect(api.plan).toHaveBeenCalledTimes(1);
  });

  it("requires a new plan after a failed guarded deployment", async () => {
    const api = apiStub();
    api.deploy.mockRejectedValue(new Error("Job modify index mismatch"));
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    await planJob();
    fireEvent.click(screen.getByRole("button", { name: "Deploy planned job" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Plan again"));
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
  });

  it("ignores a pending submission completion after unmount", async () => {
    const api = apiStub();
    const pending = Promise.withResolvers<{}>();
    api.deploy.mockReturnValue(pending.promise);
    const onDeployed = vi.fn();
    const { unmount } = render(<JobEditor api={api} namespace="default" canManage onDeployed={onDeployed} />);
    await planJob();
    fireEvent.click(screen.getByRole("button", { name: "Deploy planned job" }));
    unmount();
    await act(async () => { pending.resolve({}); });
    expect(onDeployed).not.toHaveBeenCalled();
  });

  it("invalidates plans when namespace or host API changes without losing dirty source", async () => {
    const api = apiStub();
    const { rerender } = render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    await planJob();
    const source = (screen.getByLabelText("Job source") as HTMLTextAreaElement).value;
    rerender(<JobEditor api={api} namespace="team" canManage onDeployed={() => {}} />);
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    expect((screen.getByLabelText("Job source") as HTMLTextAreaElement).value).toBe(source);
    rerender(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
    await screen.findByRole("button", { name: "Deploy planned job" });
    rerender(<JobEditor api={apiStub()} namespace="default" canManage onDeployed={() => {}} />);
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    expect(api.deploy).not.toHaveBeenCalled();
  });

  it("shows placement reasons and real allocation preemptions from scheduler annotations", async () => {
    const api = apiStub();
    api.plan.mockResolvedValue({ JobModifyIndex: 17, FailedTGAllocs: { web: { NodesEvaluated: 4, NodesFiltered: 4, ConstraintFiltered: { "missing driver": 4 } } }, Annotations: { PreemptedAllocs: [{ ID: "preempted-id", Name: "old.web[0]", NodeID: "node-1" }] } });
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    await planJob();
    expect(screen.getByText("missing driver: 4")).toBeTruthy();
    expect(screen.getByText("Nodes evaluated: 4 / exhausted: 0 / filtered: 4")).toBeTruthy();
    expect(screen.getByText("old.web[0] / allocation preempted-id / node node-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to editor" }));
    expect(screen.queryByRole("region", { name: "Job plan" })).toBeNull();
    expect((screen.getByLabelText("Job source") as HTMLTextAreaElement).value).toBe('job "web" {}');
  });

  it("loads stored HCL source and variables without replacing dirty content on external refresh", async () => {
    const api = apiStub();
    const initialSubmission: JobSubmission = { Source: 'job "web" { image = var.image }', Format: "hcl2", Variables: 'image = "nginx:stable"' };
    const { rerender } = render(<JobEditor api={api} namespace="default" canManage initialJob={job} initialSubmission={initialSubmission} onDeployed={() => {}} />);
    expect((screen.getByLabelText("Job source") as HTMLTextAreaElement).value).toBe(initialSubmission.Source);
    expect((screen.getByLabelText("HCL variable values") as HTMLTextAreaElement).value).toBe(initialSubmission.Variables);
    fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
    await screen.findByRole("button", { name: "Deploy planned job" });
    fireEvent.click(screen.getByRole("button", { name: "Deploy planned job" }));
    await waitFor(() => expect(api.deploy).toHaveBeenCalledWith(expect.anything(), 17, initialSubmission));
    changeSource("my unsaved edits");
    rerender(<JobEditor api={api} namespace="default" canManage initialJob={{ ...job, Version: 2 }} initialSubmission={{ ...initialSubmission, Source: "refreshed source" }} onDeployed={() => {}} />);
    expect((screen.getByLabelText("Job source") as HTMLTextAreaElement).value).toBe("my unsaved edits");
  });

  it("imports JSON job files, invalidates the old plan and submits the exact original JSON", async () => {
    const api = apiStub();
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    await planJob();
    const source = '{"Job":{"ID":"web","Meta":{"owner":"ops"}}}';
    fireEvent.change(screen.getByLabelText("Import job file"), { target: { files: [new File([source], "web.json")] } });
    await waitFor(() => expect((screen.getByLabelText("Job source") as HTMLTextAreaElement).value).toBe(source));
    expect((screen.getByLabelText("Job format") as HTMLSelectElement).value).toBe("json");
    expect(screen.queryByRole("button", { name: "Deploy planned job" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
    await screen.findByRole("button", { name: "Deploy planned job" });
    fireEvent.click(screen.getByRole("button", { name: "Deploy planned job" }));
    await waitFor(() => expect(api.deploy).toHaveBeenCalledWith(expect.anything(), 17, { Source: source, Format: "json" }));
    expect(api.parse).toHaveBeenLastCalledWith(source, "json", "");
  });

  it("imports dropped HCL and variable files", async () => {
    const api = apiStub();
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    const source = 'job "web" { image = var.image }';
    fireEvent.drop(screen.getByLabelText("Job source").parentElement!, { dataTransfer: { files: [new File([source], "web.nomad.hcl")] } });
    await waitFor(() => expect((screen.getByLabelText("Job source") as HTMLTextAreaElement).value).toBe(source));
    fireEvent.change(screen.getByLabelText("Import HCL variables"), { target: { files: [new File(['image = "nginx"'], "web.nomadvars.hcl")] } });
    await waitFor(() => expect((screen.getByLabelText("HCL variable values") as HTMLTextAreaElement).value).toBe('image = "nginx"'));
    fireEvent.click(screen.getByRole("button", { name: "Plan job" }));
    await screen.findByRole("button", { name: "Deploy planned job" });
    expect(api.parse).toHaveBeenCalledWith(source, "hcl", 'image = "nginx"');
  });

  it("rejects oversized file imports without overwriting the draft", async () => {
    const api = apiStub();
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    changeSource("keep this draft");
    fireEvent.change(screen.getByLabelText("Import job file"), { target: { files: [new File(["a".repeat(1024 * 1024 + 1)], "large.hcl")] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("at most 1 MiB"));
    expect((screen.getByLabelText("Job source") as HTMLTextAreaElement).value).toBe("keep this draft");
    expect(api.parse).not.toHaveBeenCalled();
  });

  it("does not let a late file read replace subsequent user edits", async () => {
    const api = apiStub();
    let reader!: FileReader;
    vi.spyOn(FileReader.prototype, "readAsText").mockImplementation(function (this: FileReader) { reader = this; });
    render(<JobEditor api={api} namespace="default" canManage onDeployed={() => {}} />);
    fireEvent.change(screen.getByLabelText("Import job file"), { target: { files: [new File(["old import"], "old.hcl")] } });
    changeSource("new edits");
    Object.defineProperty(reader, "result", { value: "old import" });
    await act(async () => { reader.dispatchEvent(new ProgressEvent("load")); });
    expect((screen.getByLabelText("Job source") as HTMLTextAreaElement).value).toBe("new edits");
  });

  it("downloads original source and variable contents without canonicalizing them", async () => {
    const api = apiStub();
    const initialSubmission: JobSubmission = { Source: 'job "web" { # keep this comment\n}', Format: "hcl2", Variables: 'image = "nginx" # private value\n' };
    const createObjectURL = vi.fn((_blob: Blob) => "blob:job-download");
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = vi.fn(); });
    const filenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { filenames.push(this.download); });
    render(<JobEditor api={api} namespace="default" canManage initialSubmission={initialSubmission} onDeployed={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Export job source" }));
    fireEvent.click(screen.getByRole("button", { name: "Export HCL variables" }));
    expect(filenames).toEqual(["job.nomad.hcl", "job.nomadvars.hcl"]);
    for (const [index, expected] of [initialSubmission.Source, initialSubmission.Variables].entries()) {
      const { promise, resolve, reject } = Promise.withResolvers<string | ArrayBuffer | null>();
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(createObjectURL.mock.calls[index][0]);
      expect(await promise).toBe(expected);
    }
    expect(api.parse).not.toHaveBeenCalled();
  });
});
