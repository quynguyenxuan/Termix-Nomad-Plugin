import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdministrationPage } from "../../src/frontend/AdministrationPage";
import { AdminEditor, type AdminKind } from "../../src/frontend/AdminForms";
import { RefreshContext, type PageProps } from "../../src/frontend/ResourceUI";

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({ usePluginApi: () => client }));
const props: PageProps = { hostId: "7", namespace: "default", canManage: true, canAdmin: true, canExec: false, onNavigate: vi.fn() };
const accessor = "11111111-1111-4111-8111-111111111111";
const token = { AccessorID: accessor, Name: "operator", Type: "client", Policies: ["read"], Roles: [] };
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  client.get.mockImplementation(async (path: string) => {
    if (path.endsWith(`/tokens/${accessor}`)) return { data: { ...token } };
    if (path.endsWith("/tokens")) return { data: { items: [token], nextToken: "" } };
    return { data: { items: [], nextToken: "" } };
  });
  client.post.mockResolvedValue({ data: { token, secret: "explicit-secret" } });
  client.put.mockResolvedValue({ data: null }); client.delete.mockResolvedValue({ data: null });
});
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function confirm(label: string) { fireEvent.click(screen.getByRole("button", { name: label })); fireEvent.click(screen.getByRole("button", { name: `Confirm ${label}` })); }
async function openToken() {
  fireEvent.click(screen.getByRole("button", { name: "ACL tokens" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open operator" }));
  await screen.findByLabelText("Token name");
}

describe("Administration native forms", () => {
  it.each([
    ["namespaces", [["Name", "team"], ["Default node pool", "workers"], ["Allowed node pools (one per line)", "workers\ngpu"]], { Name: "team", NodePoolConfiguration: { Default: "workers", Allowed: ["workers", "gpu"], Denied: [] } }],
    ["policies", [["Name", "read"], ["HCL rules", 'namespace "team" { policy = "read" }']], { Name: "read", Rules: 'namespace "team" { policy = "read" }' }],
    ["roles", [["Name", "reader"], ["Policy names (one per line)", "read\nlogs"]], { Name: "reader", Policies: [{ Name: "read" }, { Name: "logs" }] }],
    ["tokens", [["Token name", "operator"], ["Policy names (one per line)", "read"], ["Role IDs (one per line)", accessor], ["Expiration TTL", "1h"]], { Name: "operator", Type: "client", Policies: ["read"], Roles: [{ ID: accessor }], ExpirationTTL: "1h" }],
    ["auth-methods", [["Name", "sso"], ["OIDC discovery URL", "https://identity.example"], ["OIDC client ID", "nomad"], ["Allowed redirect URIs (one per line)", "https://nomad.example/callback"]], { Name: "sso", Type: "OIDC", Config: { OIDCDiscoveryURL: "https://identity.example", OIDCClientID: "nomad", AllowedRedirectURIs: ["https://nomad.example/callback"] } }],
    ["binding-rules", [["Authentication method name", "sso"], ["Claim selector", '"ops" in list.groups'], ["Binding name or template", "reader"]], { AuthMethod: "sso", Selector: '"ops" in list.groups', BindType: "role", BindName: "reader" }],
    ["sentinel", [["Name", "guard"], ["Sentinel policy source", "main = rule { true }"]], { Name: "guard", Scope: "submit-job", EnforcementLevel: "advisory", Policy: "main = rule { true }" }],
  ] as const)("creates %s from labeled controls only after confirmation", async (kind, fields, expected) => {
    const save = vi.fn(async () => {});
    render(<AdminEditor kind={kind as AdminKind} onSave={save} />);
    fields.forEach(([label, value]) => change(label, value));
    fireEvent.click(screen.getByRole("button", { name: "Create resource" })); expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Create resource" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining(expected)));
  });
  it("keeps JSON supplemental and rejects invalid JWT public keys visibly", async () => {
    const save = vi.fn(async () => {});
    render(<AdminEditor kind="auth-methods" onSave={save} />);
    change("Authentication type", "JWT"); change("JWT validation public keys (JSON array)", "not JSON"); confirm("Create resource");
    await screen.findByText("JWT public keys must be a JSON array of PEM strings."); expect(save).not.toHaveBeenCalled();
  });
});

describe("Administration access and token secrets", () => {
  it("does not fetch administration data for manage-only users", () => {
    render(<AdministrationPage {...props} canAdmin={false} />);
    expect(client.get).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "Create Namespaces" })).toBeNull();
  });
  it("updates tokens with confirmed forms, keeps drafts through refresh, and never implies connection replacement", async () => {
    const view = (tick: number) => <RefreshContext.Provider value={tick}><AdministrationPage {...props} /></RefreshContext.Provider>;
    const { rerender } = render(view(0)); await openToken();
    change("Token name", "edited"); rerender(view(1));
    await waitFor(() => expect(client.get.mock.calls.filter(([path]) => path.endsWith(`/tokens/${accessor}`)).length).toBeGreaterThan(1));
    expect((screen.getByLabelText("Token name") as HTMLInputElement).value).toBe("edited");
    confirm("Save changes");
    await waitFor(() => expect(client.put).toHaveBeenCalledWith(`/hosts/7/administration/tokens/${accessor}`, expect.objectContaining({ Name: "edited", Policies: ["read"] }), { params: { namespace: "default" } }));
    expect(screen.queryByLabelText("Secret ID")).toBeNull();
  });
  it("reveals only after confirmation, clears secrets on hide or navigation, and clones with an independent expiration", async () => {
    render(<AdministrationPage {...props} />); await openToken();
    fireEvent.click(screen.getByRole("button", { name: "Reveal token secret" })); expect(client.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Reveal token secret" }));
    expect((await screen.findByLabelText("Secret ID") as HTMLInputElement).value).toBe("explicit-secret");
    fireEvent.click(screen.getByRole("button", { name: "Hide secret" })); expect(screen.queryByLabelText("Secret ID")).toBeNull();
    change("Cloned token name", "copy"); change("Cloned token expiration TTL", "2h"); confirm("Clone token");
    await waitFor(() => expect(client.post).toHaveBeenCalledWith(`/hosts/7/administration/tokens/${accessor}/clone`, { Name: "copy", ExpirationTTL: "2h" }, { params: { namespace: "default" } }));
    await screen.findByLabelText("Secret ID"); fireEvent.click(screen.getByRole("button", { name: "ACL policies" }));
    expect(screen.queryByLabelText("Secret ID")).toBeNull();
  });
  it("does not reveal a late secret response after navigation", async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    client.post.mockImplementation(() => promise);
    render(<AdministrationPage {...props} />); await openToken(); confirm("Reveal token secret");
    fireEvent.click(screen.getByRole("button", { name: "ACL policies" })); resolve({ data: { secret: "late-secret" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create ACL policies" })).toBeTruthy());
    expect(screen.queryByLabelText("Secret ID")).toBeNull(); expect(screen.queryByText("late-secret")).toBeNull();
  });
  it("surfaces Sentinel edition errors and action failures instead of pretending success", async () => {
    client.get.mockImplementation(async (path: string) => { if (path.endsWith("/sentinel")) throw new Error("Nomad request failed (403): edition or ACL denied"); return { data: { items: [], nextToken: "" } }; });
    render(<AdministrationPage {...props} />); fireEvent.click(screen.getByRole("button", { name: "Sentinel policies" }));
    await screen.findByText("Nomad request failed (403): edition or ACL denied");
    fireEvent.click(screen.getByRole("button", { name: "Create Sentinel policies" })); change("Name", "guard"); change("Sentinel policy source", "main = rule { true }");
    client.post.mockRejectedValueOnce(new Error("Nomad request failed (403)")); confirm("Create resource");
    await screen.findByText("Nomad request failed (403)"); expect(screen.queryByText("Saved successfully.")).toBeNull();
  });
  it("deletes a selected token only after destructive confirmation", async () => {
    render(<AdministrationPage {...props} />); await openToken();
    fireEvent.click(screen.getByRole("button", { name: "Delete operator" })); expect(client.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete operator" }));
    await waitFor(() => expect(client.delete).toHaveBeenCalledWith(`/hosts/7/administration/tokens/${accessor}`, { params: { namespace: "default" } }));
    await screen.findByText("Deleted successfully.");
  });
});
