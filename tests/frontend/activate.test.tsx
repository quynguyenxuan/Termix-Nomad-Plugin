import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderWithApp, type RenderedPluginApp } from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

let rendered: RenderedPluginApp | null = null;
afterEach(async () => { await rendered?.deactivate(); rendered = null; });

describe("Nomad activation", () => {
  it("registers the Nomad tab and filters host actions using only the Nomad switch", async () => {
    rendered = await renderWithApp(plugin, { manifest: manifestJson as unknown as PluginManifest, locales, permissions: ["nomad.use"] });
    expect(rendered.registered.tabs()).toEqual(["nomad"]);
    const [action] = rendered.registered.hostActions();
    expect(action).toEqual(expect.objectContaining({ id: "nomad", tabType: "nomad" }));
    const host = { id: "7", name: "cluster", ip: "10.0.0.7", port: 22, enableSsh: false, pluginSettings: { nomad: { enableNomad: true } } };
    await waitFor(() => expect(rendered!.registered.hostActionsFor(host).map((item) => item.id)).toEqual(["nomad"]));
    expect(rendered.registered.hostActionsFor({ ...host, pluginSettings: { nomad: { enableNomad: false } } })).toEqual([]);
    expect(rendered.registered.hostActionsFor({ ...host, pluginSettings: { docker: { enableDocker: true } } })).toEqual([]);
  });

});
