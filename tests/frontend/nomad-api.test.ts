import { describe, expect, it, vi } from "vitest";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import { createNomadApi, errorMessage } from "../../src/frontend/nomad-api";

describe("Nomad consumer API", () => {
  it("normalizes null lists and surfaces backend errors", async () => {
    const api = createNomadApi({ get: vi.fn(async () => ({ data: null })) } as unknown as PluginApiClient, "7", "default");
    expect(await api.jobs()).toEqual([]);
    expect(await api.nodes()).toEqual([]);
    expect(await api.namespaces()).toEqual([]);
    expect(await api.allocations("web")).toEqual([]);
    expect(errorMessage({ response: { data: { error: "ACL denied" } } })).toBe("ACL denied");
    expect(errorMessage(new Error("Connection refused"))).toBe("Connection refused");
  });
});
