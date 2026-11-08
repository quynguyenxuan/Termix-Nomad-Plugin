import { useMemo } from "react";
import { usePluginApi, type PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";

export interface JobService { Name?: string; Provider?: string; PortLabel?: string; Tags?: string[]; [key: string]: unknown }
export interface Constraint { LTarget?: string; Operand?: string; RTarget?: string }
export interface JobTask {
  Name: string; Driver?: string; Resources?: { CPU?: number; MemoryMB?: number; MemoryMaxMB?: number; DiskMB?: number; [key: string]: unknown };
  Constraints?: Constraint[]; Services?: JobService[]; [key: string]: unknown;
}
export interface JobGroup {
  Name: string; Count?: number; Tasks?: JobTask[]; Constraints?: Constraint[]; Services?: JobService[]; [key: string]: unknown;
}
export interface Job {
  ID: string;
  Name?: string;
  Namespace?: string;
  Type?: string;
  Status?: string;
  Version?: number;
  TaskGroups?: JobGroup[];
  Constraints?: Constraint[];
  Periodic?: Record<string, unknown> | null;
  ParameterizedJob?: { Payload?: string; MetaRequired?: string[]; MetaOptional?: string[] } | null;
  [key: string]: unknown;
}
export interface Node {
  ID: string;
  Name?: string;
  Status?: string;
  Datacenter?: string;
  SchedulingEligibility?: string;
}
export interface Allocation {
  ID: string;
  Name?: string;
  TaskGroup?: string;
  NodeID?: string;
  ClientStatus?: string;
  TaskStates?: Record<string, { State?: string; Failed?: boolean }> | null;
}
export interface PlanResult {
  JobModifyIndex: number;
  Diff?: unknown;
  Annotations?: { DesiredTGUpdates?: Record<string, Record<string, number>>; PreemptedAllocs?: Allocation[] } | null;
  NextPeriodicLaunch?: string;
  FailedTGAllocs?: Record<string, unknown> | null;
  [key: string]: unknown;
}
export type Format = "hcl" | "json";

export interface JobSubmission {
  Source: string;
  Format: "hcl2" | "json";
  Variables?: string;
}
export interface JobValidation {
  DriverConfigValidated: boolean;
  ValidationErrors: string[];
  Error: string;
  Warnings: string;
}

export interface ConsulStatus {
  configured: boolean;
  status: "unconfigured" | "connected" | "error";
  uiUrl?: string;
  nomadUiUrl?: string;
  error?: string;
}
export interface ConsulCheck {
  id: string;
  name: string;
  serviceId: string;
  serviceName: string;
  node: string;
  status: string;
  output?: string;
}
export interface JobConsulStatus extends ConsulStatus {
  usesConsul: boolean;
  health: "passing" | "warning" | "critical" | "unknown" | "not-applicable";
  checks: ConsulCheck[];
  expectedServices: number;
  partial: boolean;
}

export function errorMessage(error: unknown): string {
  const data = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data;
  if (typeof data?.error === "string") return data.error;
  return error instanceof Error ? error.message : "Nomad request failed";
}

export interface NomadApi {
  status(): Promise<{ leader: string }>;
  namespaces(): Promise<{ Name: string }[]>;
  jobs(): Promise<Job[]>;
  nodes(): Promise<Node[]>;
  job(jobId: string): Promise<Job>;
  jobConsul(jobId: string): Promise<JobConsulStatus>;
  allocations(jobId: string): Promise<Allocation[]>;
  allocation(allocationId: string): Promise<Allocation>;
  logs(allocationId: string, task: string, type: "stdout" | "stderr"): Promise<string>;
  parse(source: string, format: Format, variables?: string): Promise<Job>;
  validate(job: Job): Promise<JobValidation>;
  submission(jobId: string, version: number): Promise<JobSubmission | null>;
  plan(job: Job): Promise<PlanResult>;
  deploy(job: Job, modifyIndex: number, submission?: JobSubmission): Promise<unknown>;
  scale(jobId: string, group: string, count: number): Promise<unknown>;
  stop(jobId: string): Promise<unknown>;
}

export function createNomadApi(api: PluginApiClient, hostId: string, namespace: string): NomadApi {
  const root = `/hosts/${encodeURIComponent(hostId)}`;
  const path = (suffix: string, params?: Record<string, string>) =>
    `${root}${suffix}?${new URLSearchParams({ namespace, ...params })}`;
  const id = encodeURIComponent;
  return {
    status: async () => (await api.get<{ leader: string }>(path("/status"))).data,
    namespaces: async () => (await api.get<{ Name: string }[]>(path("/namespaces"))).data ?? [],
    jobs: async () => (await api.get<Job[]>(path("/jobs"))).data ?? [],
    nodes: async () => (await api.get<Node[]>(path("/node-list"))).data ?? [],
    job: async (jobId: string) => (await api.get<Job>(path(`/jobs/${id(jobId)}`))).data,
    jobConsul: async (jobId: string) => (await api.get<JobConsulStatus>(path(`/jobs/${id(jobId)}/consul`))).data,
    allocations: async (jobId: string) => (await api.get<Allocation[]>(path(`/jobs/${id(jobId)}/allocations`))).data ?? [],
    allocation: async (allocationId: string) => (await api.get<Allocation>(path(`/allocations/${id(allocationId)}`))).data,
    logs: async (allocationId: string, task: string, type: "stdout" | "stderr") =>
      (await api.get<{ text: string }>(path(`/allocations/${id(allocationId)}/logs`, { task, type }))).data.text,
    parse: async (source: string, format: Format, variables = "") => (await api.post<Job>(path("/parse"), { source, format, variables })).data,
    validate: async (job: Job) => (await api.post<JobValidation>(path("/validate"), { job })).data,
    submission: async (jobId: string, version: number) => (await api.get<JobSubmission | null>(path(`/jobs/${id(jobId)}/submission`, { version: String(version) }))).data,
    plan: async (job: Job) => (await api.post<PlanResult>(path("/plan"), { job })).data,
    deploy: async (job: Job, modifyIndex: number, submission?: JobSubmission) => (await api.put(path("/jobs"), { job, modifyIndex, ...(submission ? { submission } : {}) })).data,
    scale: async (jobId: string, group: string, count: number) =>
      (await api.post(path(`/jobs/${id(jobId)}/scale`), { group, count })).data,
    stop: async (jobId: string) => (await api.delete(path(`/jobs/${id(jobId)}`))).data,
  };
}

export function useNomadApi(hostId: string, namespace: string) {
  const api = usePluginApi();
  return useMemo(() => createNomadApi(api, hostId, namespace), [api, hostId, namespace]);
}
