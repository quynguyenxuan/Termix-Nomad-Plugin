import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JobDetail } from "../../src/frontend/JobDetail";
import type { Job, JobConsulStatus, JobSubmission, NomadApi } from "../../src/frontend/nomad-api";

afterEach(cleanup);
const job = { ID: "web", Namespace: "default", Version: 3, TaskGroups: [] };
const submission: JobSubmission = { Source: 'job "web" {}', Format: "hcl2", Variables: 'image = "nginx"' };
function apiStub() {
  return {
    job: vi.fn(async (): Promise<Job> => job), allocations: vi.fn(async () => []),
    jobConsul: vi.fn(async (): Promise<JobConsulStatus> => ({ configured: false, status: "unconfigured", usesConsul: false, health: "not-applicable", checks: [], expectedServices: 0, partial: false })),
    submission: vi.fn(async (_id: string, _version: number): Promise<JobSubmission | null> => submission),
  } as unknown as NomadApi;
}

describe("editing a stored job specification", () => {
  it("loads the selected job version only on request and keeps Edit as JSON", async () => {
    const api = apiStub();
    const onEdit = vi.fn();
    render(<JobDetail api={api} jobId="web" canManage={false} onEdit={onEdit} onChanged={() => {}} onNavigate={() => {}} />);
    await screen.findByRole("button", { name: "Edit job specification" });
    expect(api.submission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit job specification" }));
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(job, submission));
    expect(api.submission).toHaveBeenCalledWith("web", 3);
    fireEvent.click(screen.getByRole("button", { name: "Edit as JSON" }));
    expect(onEdit).toHaveBeenLastCalledWith(job);
  });

  it("explains absent stored source without silently substituting JSON", async () => {
    const api = apiStub();
    vi.mocked(api.submission).mockResolvedValue(null);
    const onEdit = vi.fn();
    render(<JobDetail api={api} jobId="web" canManage onEdit={onEdit} onChanged={() => {}} onNavigate={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit job specification" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("No original specification is stored"));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Edit as JSON" })).toBeTruthy();
  });

  it("does not reopen an editor after the detail unmounts", async () => {
    const api = apiStub();
    const pending = Promise.withResolvers<JobSubmission | null>();
    vi.mocked(api.submission).mockReturnValue(pending.promise);
    const onEdit = vi.fn();
    const { unmount } = render(<JobDetail api={api} jobId="web" canManage onEdit={onEdit} onChanged={() => {}} onNavigate={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit job specification" }));
    unmount();
    await act(async () => { pending.resolve(submission); });
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("does not replace a JSON editor with a late original-source response", async () => {
    const api = apiStub();
    const pending = Promise.withResolvers<JobSubmission | null>();
    vi.mocked(api.submission).mockReturnValue(pending.promise);
    const onEdit = vi.fn();
    render(<JobDetail api={api} jobId="web" canManage onEdit={onEdit} onChanged={() => {}} onNavigate={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit job specification" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit as JSON" }));
    await act(async () => { pending.resolve(submission); });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(job);
  });
});

describe("job Consul integration boundaries", () => {
  it("does not query Consul for native Nomad services and preserves their catalog navigation", async () => {
    const api = apiStub();
    vi.mocked(api.job).mockResolvedValue({ ...job, TaskGroups: [{ Name: "web", Services: [{ Name: "native-web", Provider: "nomad" }] }] });
    const onNavigate = vi.fn();
    render(<JobDetail api={api} jobId="web" canManage={false} onEdit={() => {}} onChanged={() => {}} onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "native-web / nomad / port default" }));
    expect(onNavigate).toHaveBeenCalledWith("services", "native-web");
    expect(api.jobConsul).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Consul service health" })).toBeNull();
  });

  it.each(["group", "task"])("shows read-only Consul health for default-provider %s services without native catalog links", async location => {
    const api = apiStub();
    const service = { Name: "consul-web" };
    vi.mocked(api.job).mockResolvedValue({ ...job, TaskGroups: [{ Name: "web", ...(location === "group" ? { Services: [service] } : { Tasks: [{ Name: "server", Services: [service] }] }) }] });
    vi.mocked(api.jobConsul).mockResolvedValue({ configured: false, status: "unconfigured", usesConsul: true, health: "unknown", checks: [], expectedServices: 1, partial: false });
    const onNavigate = vi.fn();
    render(<JobDetail api={api} jobId="web" canManage={false} onEdit={() => {}} onChanged={() => {}} onNavigate={onNavigate} />);
    await screen.findByText("Consul health: unknown");
    expect(screen.getByText(/Configure a Consul API address/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "consul-web / consul / port default" })).toBeNull();
    fireEvent.click(screen.getByText("consul-web / consul / port default"));
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh details" }));
    await waitFor(() => expect(api.jobConsul).toHaveBeenCalledTimes(2));
  });

  it("does not expose an old job's health while a new namespace is loading", async () => {
    const oldApi = apiStub();
    vi.mocked(oldApi.job).mockResolvedValue({ ...job, TaskGroups: [{ Name: "web", Services: [{ Name: "old-private-service", Provider: "consul" }] }] });
    vi.mocked(oldApi.jobConsul).mockResolvedValue({ configured: true, status: "connected", usesConsul: true, health: "critical", checks: [], expectedServices: 1, partial: true });
    const props = { jobId: "web", canManage: false, onEdit: () => {}, onChanged: () => {}, onNavigate: () => {} };
    const { rerender } = render(<JobDetail api={oldApi} {...props} />);
    await screen.findByText("Consul health: critical");
    const newApi = apiStub();
    const pending = Promise.withResolvers<Job>();
    vi.mocked(newApi.job).mockReturnValue(pending.promise);
    rerender(<JobDetail api={newApi} {...props} />);
    expect(screen.queryByText(/old-private-service/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Consul service health" })).toBeNull();
    expect(screen.getByText("Loading job...")).toBeTruthy();
    await act(async () => { pending.resolve({ ...job, Namespace: "team-b" }); });
    expect(newApi.jobConsul).not.toHaveBeenCalled();
  });
});
