# Nomad for Termix

Development fork of [Termix-SSH/Plugin-Docker](https://github.com/Termix-SSH/Plugin-Docker), based on commit `0acff64b737600d9c8c4565ea94a302222b42c78`, maintained at [quynguyenxuan/Termix-Nomad-Plugin](https://github.com/quynguyenxuan/Termix-Nomad-Plugin). The Docker plugin remains separate; this plugin has ID `nomad`. It is not an official HashiCorp or Termix release and is not published to the Termix registry. The original Apache-2.0 license is retained in `LICENSE`.

The Docker-specific SSH, container console and Compose implementation is replaced with a TypeScript Nomad HTTP client. Its protocol follows the official [Nomad Go API](https://github.com/hashicorp/nomad/tree/main/api): `api.go`, `jobs.go`, `nodes.go`, `allocations.go` and `fs.go`. No Go sidecar, unofficial JavaScript Nomad SDK or copied Go implementation is required. Termix's plugin SDK remains responsible for host access, permissions, encrypted host settings and guarded outbound HTTP.

## Use

Requires Node 24 for development and Termix 26.11 or newer.

1. Enable Plugin developer mode in Termix and create an API key.
2. Install dependencies with `npm ci --ignore-scripts`.
3. Export `TERMIX_SERVER_URL` and `TERMIX_API_KEY` from a private environment file. Never commit the key.
4. Run `npx termix-plugin dev --once`, or omit `--once` to watch and reinstall changes. Reload Termix after frontend changes.
5. Edit an accessible host, open its Nomad section and enable Nomad. Set the API URL, encrypted ACL token and region. Empty URL uses `http://<host IP>:4646`; it does not tunnel over SSH.
6. Save, open Nomad from the main navigation and choose the cluster connection. The host menu remains a shortcut to that cluster.

The API must be reachable from the **Termix server**, not just the browser. Use HTTPS with a trusted certificate or an explicitly trusted private network. TLS verification stays enabled. URLs are configured by host editors, never accepted from job-operation requests. An ACL token should grant only the namespaces and operations its users need; Termix permissions do not narrow an overprivileged cluster token.

The main Nomad tab lists enabled cluster connections visible to your current Termix account, excluding view-only shared hosts. Each endpoint manages the whole cluster, not just its saved host. Switching clusters clears the prior connection's workspace and pending plans. An account with no accessible connections sees setup and sharing guidance instead of a blank dashboard; adding the menu does not grant host access.

### Retained local cluster

The parent `../compose.yml` also runs Nomad 2.1.1 as `termix-nomad`, configured by `../nomad.hcl`, with ACLs and a persistent `nomad-data` volume. Termix uses the private API `http://nomad:4646`; the native UI/API port is published only on the host's Tailscale address at `http://100.88.18.82:4646/ui/`. Host `ubuntu22-tmp (ohmypi)` has Nomad enabled and an encrypted ACL credential. Open **Nomad** from the main navigation, then use **Open Nomad UI** beside **Open Consul UI** to open the native interface in a new tab. Native Nomad UI requires its own Nomad ACL login; no token is appended to the link.

Termix itself is pinned to the exact stable 26.11.0 image digest in the parent Compose file. After the beta trial, its pre-upgrade backup was restored to `termix_termix-data-stable-restore-20261107T152121Z`; Compose explicitly selects that volume. The former beta data volume, `termix_termix-data`, is retained but not mounted by the stable service. Do not point the older server at beta-migrated data. The protected pre-upgrade archive and original configuration remain in `../backups/pre-26.11.1-beta.1-20261107T145612Z/`; these contain sensitive data and must not be published. DNS and Network Devices are not installed on this stable instance.

Start the already initialized local services with `docker compose up -d` from the parent directory. The volume must be owned by UID/GID `65534:65534` on a fresh installation before starting Nomad. Bootstrap ACLs once, keep the bootstrap credential private, and configure the host's API URL and encrypted token through the host editor. The local bootstrap credential is retained in the parent `.env` as `NOMAD_LOCAL_BOOTSTRAP_TOKEN` (mode `600`, ignored by Git); never paste it into chat or commit it.

The retained `termix-demo` job runs a small shell loop and emits `Termix Nomad demo is running`. Agent-browser verified the host action, connected topology, running job and logs at `http://100.88.18.82:8082/`, including after recreating the Nomad container. Do not use `docker compose down -v` if keeping cluster state.

This is a single-node local development cluster, not HA or production. Nomad runs unprivileged, without a Docker socket or host filesystem mounts other than its read-only configuration; only `raw_exec` demo workloads are supported. Scheduling is capped at 1000 CPU units and 256 MiB within the container's one-CPU/512-MiB limit. HTTP is limited to the trusted Compose network, not a substitute for production TLS and isolated workloads.

### Local Consul integration

The parent Compose deployment also runs persistent Consul 2.1.0 (`termix-consul`, `consul-data`, `../consul.hcl`) with ACL default deny. Its UI is `http://100.88.18.82:8500/ui/`, published only on the host's Tailscale address; its backend API is `http://consul:8500` on the private Compose network. Nomad uses `checks_use_advertise = true` because its Consul agent runs in a different container, and workload identities use the `consul.io` audience and the `nomad-workloads` JWT auth method.

Host Nomad settings include **Consul API URL**, a separately encrypted **Consul read-only ACL token**, and **Consul UI URL**. The UI link never contains a token; log in separately to Consul with `CONSUL_UI_READONLY_TOKEN` from the protected parent `.env`. That file also retains `CONSUL_BOOTSTRAP_TOKEN`, `CONSUL_NODE_AGENT_TOKEN` and `CONSUL_NOMAD_AGENT_TOKEN` for distinct administration/agent roles. Do not publish these files or Docker data backups. The plugin does not use management credentials; observer writes were denied in an actual ACL check.

The retained `termix-consul-demo` jobspec is `../consul-demo.nomad.hcl`. It runs a small private HTTP service with `provider = "consul"` and a real `/health` check; it publishes no application port on the host. Job details show its service health, check output and adjacent **Open Nomad UI** / **Open Consul UI** links. Configure **Nomad UI URL** separately from the backend API address; this link also works from the cluster header without Consul. The original `termix-demo` remains unchanged. Each Nomad client added on another host needs its own local Consul agent; do not point several clients at this one agent.

For the initialized deployment, use `docker compose up -d` from the parent directory. A fresh installation must create the data volumes with UID/GID `65534:65534`, bootstrap Consul ACLs once, provision separate node/Nomad-agent and read-only observer policies/tokens, and run `nomad setup consul` with a temporary administrative token and JWKS URL `http://nomad:4646/.well-known/jwks.json`. Save the actual agent token before recreating Nomad; without it Consul registration is denied, not silently authorized. The task role permits discovery but has no blanket KV read access. Never re-bootstrap an existing ACL-enabled cluster, and do not use `docker compose down -v` if retaining state.

This is a one-host development integration, not Consul HA, Connect/Envoy service mesh or production TLS. Host/container DNS has not been redirected to Consul. The plugin currently reads a bounded 4 MiB health list in Consul CE's default namespace; missing/ACL-filtered/oversized results stay unknown rather than passing.



## Operations

- Cluster overview/topology, paged clients, resource statistics, drain/eligibility, node pools, server/Raft details, agent metrics and live client/server monitoring.
- Jobs, complete HCL/JSON editing with syntax highlighting, authoritative syntax/configuration validation, HCL variables, file import/export, canonical JSON review, scheduler plans and guarded CAS submission. Version-specific original source remains editable. Also versions/diffs/revert, parameterized dispatch, periodic force, evaluation, scaling, stop and explicit purge; job templates use Nomad variables.
- Deployments and evaluations with rollout, placement diagnostics, allocation links and confirmed rollout actions.
- Allocation/task details, statistics, restart/stop, finite or live stdout/stderr, filesystem browsing/read/download, and authenticated xterm exec with resize and cancellation.
- Native service registrations/checks, CSI plugins/volumes/snapshots, dynamic host volumes, and variables with CAS editing/deletion.
- Administration forms for namespaces, ACL policies/roles/tokens, auth methods/binding rules and Sentinel. Unsupported Nomad edition/version/provider operations return visible errors, never simulated success.
- Resource navigation, server-side cursor/prefix/filter controls, loaded-page search, manual namespaces when discovery is denied, and refresh that preserves dirty editors and active sessions.

Host connect access and `use` are required. `manage` allows workload/storage writes; `exec` separately allows commands; `administer` allows global cluster changes, server diagnostics and ACL administration. These permissions supplement, not replace, Nomad ACLs. The configured connection token stays backend-only. Explicitly requested newly created or existing ACL token secrets are admin-only, transient, and never reveal the configured connection token.

This is a native management application, not a complete Go SDK port or an embedded Nomad UI. There is no host installation, SSH tunnel, Docker lifecycle ownership, arbitrary HTTP proxy, GitOps reconciliation or HA setup. A host record represents one configured cluster endpoint. HTTP/log/filesystem traffic uses the Nomad server proxy, not arbitrary client-node URLs. Finite logs/read previews are bounded; live streams expire after ten minutes and can reconnect. Exec is a bounded, authenticated WebSocket session. UI text is English.

## Checks

```bash
npm run typecheck
npm test
npm run build
npm run validate
```

Verified locally on Termix 26.11.0, plugin SDK 1.0.22, ACL-enabled Nomad 2.1.1 and Consul 2.1.0: 288 tests in 19 files, typecheck, build and manifest validation pass. Agent-browser exercised adjacent native UI links, official Nomad UI loading with ACL protection, job creation, stored-source editing and actual Consul health transitions from passing to critical and back. ACL-filtered empty data remained unknown; observer writes were denied. ACLs, workload identity trust, registration and passing checks survived Consul container recreation. Existing logs, exec, filesystem, variable and desktop/mobile checks are documented in the operational guide.

Real API checks cover cursor pagination, job versions/revert, stale-plan rejection without overwriting concurrent changes, scale, task restart, stop/purge, parameterized dispatch, forced periodic execution, node eligibility/drain/cancel, node-pool create/read/delete, client/server live diagnostics, binary download, host-volume registration/read/delete, variable CAS conflicts, namespace/policy/role/token and JWT auth-method/binding-rule creation. An actual read-only Nomad token can read its namespace but cannot write variables; separate-token reveal/clone works without revealing the configured management token.

The temporary smoke agent used for feature verification ran in an isolated unprivileged container without published ports, host mounts or a Docker socket and was removed afterward. The retained local cluster described above is separate. Production clusters, trusted-TLS integration, Docker-driver workloads, external OIDC login, real CSI providers/snapshots and Enterprise Sentinel enforcement are not exercised. No cluster credentials are included in this repository.

Operational details are in [docs/index.md](docs/index.md). `dist/` and generated `.tmxplug` files are ignored. Git remote `upstream` retains the Docker source; `origin` points to `git@github.com:quynguyenxuan/Termix-Nomad-Plugin.git`. Registry release automation is not configured.
