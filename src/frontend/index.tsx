import { Boxes } from "lucide-react";
import type { PluginHostRecord, ShellApi, StandaloneViewProps, TabProps, TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { NomadHome, NomadManager, nomadEnabled } from "./NomadManager";


export function activate(app: TermixApp): void {
  const NomadTab = ({ host }: TabProps) => host ? <NomadManager host={host} transport={app} /> : <NomadHome transport={app} />;
  const NomadStandalone = ({ hostId }: StandaloneViewProps) => <NomadManager hostId={hostId} transport={app} />;
  let canUse = false;
  void app.hasPermission("use").then((allowed) => { canUse = allowed; });
  const when = (host?: PluginHostRecord) => canUse && nomadEnabled(host);
  const open = (host: PluginHostRecord, shell: ShellApi) => shell.openTab(host, "nomad");
  app.registerTab("nomad", NomadTab, {
    icon: Boxes,
    titleKey: "nav.nomad",
    hostless: true,
    persistent: true,
    standalone: NomadStandalone,
  });
  app.registerRailItem({ id: "nomad", titleKey: "nav.nomad", icon: Boxes, kind: "tab", group: "tools", permission: "use", simplePreset: true });
  app.registerHostAction({
    id: "nomad", titleKey: "nav.nomad", icon: Boxes,
    kind: "open", order: 30, tabType: "nomad", copyUrlView: "nomad", when,
  });
  app.registerHostContextMenuItem({
    id: "nomad.open", titleKey: "nav.nomad", icon: Boxes, when, run: open,
  });
  app.registerPaletteEntry({
    id: "nomad.open", titleKey: "nav.nomad", icon: Boxes,
    scope: "host", keywords: ["nomad", "jobs", "allocations"], when,
    run: (shell, host) => { if (host && when(host)) open(host, shell); },
  });
}
