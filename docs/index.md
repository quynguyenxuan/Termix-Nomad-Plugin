# Native Nomad management

A Termix host is a saved Nomad cluster connection. Its endpoint may be a different server or a load balancer. This plugin does not install Nomad, create SSH tunnels or manipulate Docker directly.

## Configure access

1. Edit a host you can connect to, open Nomad and enable it.
2. Set the HTTP(S) API URL, encrypted ACL token and region. Empty URL derives `http://<host IP>:4646`. Embedded credentials, query strings, fragments and redirects are refused.
3. Save and open Nomad from the main navigation, then choose the cluster connection. The host menu still opens a connection directly. Reachability and trusted TLS roots are required on the Termix backend, not the browser. There is no skip-verification option.
4. Select a namespace, or type one manually if ACLs forbid enumeration. `*` supports inventory; select a concrete resource namespace before workload mutations or exec.

Optionally configure **Nomad UI URL** for the browser, separately from the backend API address. **Open Nomad UI** appears beside **Open Consul UI** in the cluster header and Consul-backed job details, and remains available in the header without Consul. Both links use a new tab with `noopener noreferrer` and reject non-HTTP(S), embedded credentials, query strings and fragments. They never auto-login or expose a backend token. The local native UI is `http://100.88.18.82:4646/ui/`; the port also serves the Nomad API and is bound only to Tailscale with Nomad ACL enforcement. An anonymous browser may show **Not Authorized** until a Nomad ACL token is supplied through the native UI; Termix and Consul logins do not authenticate it.

Termix host **connect** access and plugin `use` are required before credentials are read. `manage` authorizes workload, variable and storage writes; `exec` separately authorizes task commands; `administer` controls global node/pool mutations, server diagnostics and ACL administration. Nomad independently checks the saved token. These are shared connection credentials: anyone allowed to use that host acts within that token's capabilities. Do not broadly share a management token.

## Navigation and refresh

The main-menu cluster selector lists Nomad-enabled hosts owned by or shared with the current account with connect access. A saved host represents one endpoint for a whole multi-client cluster; it does not limit inventory to that host. No visible connection means the account needs a configured host or an explicit connect share, not a global administrator role. Switching clusters clears the previous workspace and pending plans. The selector never reveals another account's hosts or credentials.

Overview/topology reports utilization and placement for the visible node/allocation pages, not invented cluster-wide totals. Clients expose resources, drivers, events, allocations, statistics, authenticated live agent monitoring, confirmed drain/cancel and scheduling eligibility. Pools expose definitions, members and jobs. Servers expose membership, Raft, connected-agent metrics and authenticated live monitoring.

Lists support server cursor pages, ID prefix, Nomad filters and search within the loaded page. Unsupported filter/API capabilities produce visible errors. Refresh can be manual or periodic, pauses while the document is hidden, and does not intentionally replace dirty forms or restart active terminals. Endpoint/host/namespace navigation discards the previous connection's data and privileged sessions.

## Jobs and scheduling

Open **Nomad > Jobs > Run job**. The native CodeMirror editor supports complete HCL or Nomad API JSON, line numbers, syntax highlighting, indentation, bracket handling and word wrapping. JSON accepts a Job object or `{ "Job": ... }`. Import a `.nomad`, `.hcl` or `.json` file or drop it onto the job editor; source and variable files are limited to 1 MiB each. Export the original source or, after validation, the full canonical JSON. The editor does not reduce jobspecs to a fixed set of form fields: driver configs, task groups, networking, services, templates, constraints, volumes, resources, scheduling and edition-specific fields are retained for Nomad to interpret.

For HCL, supply variable assignments in **HCL variable values**, or import/export a variable file. These are jobspec input variables, not the separate Nomad Variables service. JSON uses its own expanded values and does not apply hidden HCL variables. Source, variables and drafts are not saved in browser storage.

**Validate job** parses the current source and asks Nomad to validate the entire job. Syntax failures show available line/column diagnostics; configuration failures remain separate from syntax success and block planning/deployment. Validation warnings and `DriverConfigValidated` are shown explicitly: an agent that did not validate driver config is not reported as having checked it.

**Plan job** repeats parsing and validation, then requests a scheduler dry run without registration. Review the complete configuration, diff, placement failures, warnings, periodic timing and reported preemptions. **Back to editor** discards the plan. **Deploy planned job** explicitly submits only the exact planned Job with `EnforceIndex: true` and its modify index. Concurrent changes reject deployment; replan before retrying. Source, format, variables, file/template imports, host, connection or namespace changes invalidate validation and plans. Unsafe integer indices and stale asynchronous results are refused.

Submission stores the original HCL/JSON and HCL variables with the job in Nomad, as the original UI does. Treat those values as sensitive: use proper secret references instead of embedding credentials. Job details provide **Edit job specification** for the stored version-specific source and **Edit as JSON** for the expanded definition. Jobs submitted without source metadata can only offer expanded JSON editing.

For HCL outside `default`, explicitly set `namespace = "your-namespace"`; Nomad's canonical parser otherwise supplies `default`. Job namespace/region must match the selected scope. Multiregion and other edition-specific configuration is passed to Nomad; the target cluster's edition, ACLs, drivers and providers determine whether it is valid. Successful registration starts asynchronous scheduling, not a guarantee of healthy allocations. Keep one deployment owner if CI/GitOps already manages that job.

Job details include task groups, resources, constraints, services and allocations. Versions support inspection, diffs and confirmed revert. Additional actions cover parameterized dispatch with metadata/payload, periodic force, evaluate, scaling and stop. Stop retains history; purge is a separate destructive action. Job templates are stored as Nomad variables under `nomad/job-templates/`, requiring the corresponding variable ACL rights.

Deployment/evaluation pages expose rollout status, placement failures, allocation links and confirmed actions. Promote, fail, pause, resume and unblock remain subject to Nomad's state/edition checks; invalid transitions return errors rather than pretend success.

## Allocations, logs, files and exec

Allocation details expose tasks, events, resources, statistics, confirmed restart/stop and concrete-namespace links. Finite stdout/stderr tails and file previews are limited to 64 KiB. Live log/monitor streams retain only the latest 262,144 characters and expire after ten minutes; use reconnect afterward. HTTP streams and filesystem requests use the configured Nomad server proxy, never arbitrary node URLs.

The filesystem browser supports directory/stat/read and authenticated binary download. Downloads are limited to 64 MiB and five minutes. Nomad filesystem/log ACLs and server-to-client connectivity are still required. Files are not uploaded or edited by this plugin.

Exec uses an authenticated Termix WebSocket ticket, separate `exec` permission, host connect access and an unlocked session. Choose an allocation/task and supply a JSON command argument array, for example `["/bin/sh"]`. The backend resolves and pins only the configured Nomad endpoint, verifies TLS, carries the token in backend headers, bounds frames/backpressure and expires sessions after thirty minutes. It rechecks access and closes on disconnect/revocation. Browser terminal cleanup cancels the session. Commands run as the Nomad task's user and can affect workload data; they are not an SSH shell on the Termix host.

## Services, storage and variables

Services show native Nomad registrations, allocation health checks where provided, links and confirmed deregistration. Consul discovery is not synthesized.

Storage covers CSI plugin/volume details, structured create/register specs, deregister/delete, requested-capacity expansion, snapshot lifecycle and dynamic host volumes. CSI/provider capabilities, installed plugins, node permissions and Nomad version determine whether an operation is available. Snapshot credentials travel in request bodies and backend CSI headers, not URLs. No provider, mount, host path, fencing or backup system is provisioned automatically.

Variables support prefix/path browsing and key/value editing. Creation uses CAS zero; updates/deletes use the version read from Nomad. Conflicts are visible and require reload rather than overwriting a concurrent edit. Variable item values are not dumped into list responses. Their visibility still follows the configured token's ACLs.

## Consul integration

Consul is optional. In a host's Nomad settings, configure **Consul API URL** reachable from Termix, a separate **Consul read-only ACL token** with service/node read access, and **Consul UI URL** reachable from the browser. Only absolute HTTP(S) URLs without credentials, query strings or fragments are accepted. Tokens stay backend-only and are never attached to UI links. The cluster header reports Consul API reachability and offers **Open Consul UI**; this is not a claim of healthy services, service mesh or mTLS.

Jobs with group/task `provider = "consul"` services (including the default when provider is omitted) show **Consul service health** in their details. Native `provider = "nomad"` services keep their existing catalog navigation and do not need Consul. Job health validates the job and every allocation's namespace/identity before querying Consul, then associates checks by authorized Nomad allocation ServiceIDs, never service name alone. Stopped/retired allocations are excluded from current coverage. Associated node failures affect the aggregate without exposing unrelated node checks.

Known critical health takes precedence over warnings, then unknown, then passing. Missing registrations/checks, inaccessible API data and ACL-filtered results are not considered healthy just because the allocation is running. A Consul HTTP 200 response containing no visible checks remains unknown. Per-check output is bounded; unsafe upstream errors and credentials are not exposed. Service labels are not routed into the native Nomad-only Services page.

The first implementation supports Consul CE's default namespace and one configured Consul endpoint per saved Nomad connection. It reads one bounded 4 MiB health list with a ten-second deadline. It does not infer a Consul namespace from the selected Nomad namespace, synthesize absent checks, provision DNS, or install Envoy. Bigger or Enterprise multi-namespace catalogs require scoped Consul queries/configuration rather than removing the response bound.

The parent local Compose setup includes Consul 2.1.0, persistent ACL-protected storage and the example `consul-demo.nomad.hcl`. Its UI is `http://100.88.18.82:8500/ui/`; the API is private Docker DNS `consul:8500`. Native Consul login uses the protected `.env` observer token, not a query-string token or automatic privileged login. `nomad setup consul` established JWT workload identity; default broad KV access was removed. `checks_use_advertise = true` makes Nomad's own checks reachable across the two containers. A multi-host Nomad deployment needs a local Consul agent for every Nomad client.

Agent-browser verified the link into official Consul UI and the demo's actual check output. Removing only the demo's health file caused HTTP 404/critical while its allocation remained running; restoring it returned passing. Temporarily removing the observer credential produced an ACL-filtered empty result and visible unknown status, then the real credential was restored. Recreating Consul preserved ACLs, workload-identity trust, registrations and healthy checks. The demo and original job remain running; no remote/prod infrastructure or DNS resolver was changed.

## Administration

Admin-only pages provide namespace, HCL policy, role, token, auth-method, binding-rule and Sentinel forms with confirmed writes/deletion. Advanced JSON supplements ordinary labeled controls. Enterprise/version-specific APIs can be refused by Nomad and remain visibly unavailable.

Normal token responses exclude secrets. Explicit create/reveal/clone actions may display a separate ACL token secret transiently; hide it or navigate away to clear it. The configured connection token is never revealed, even when inspecting its own accessor. Cloning creates a distinct credential and does not silently copy source identity or expiration. The plugin does not bootstrap ACLs or replace its own connection token.

## Troubleshooting and limits

- Connection errors: check from the Termix backend; TLS requires a trusted certificate.
- Forbidden: inspect host connect access, plugin use/manage/exec/administer and Nomad ACLs separately.
- Index/CAS conflict: reload and replan/re-edit; do not force overwrite.
- Logs/files/exec unavailable: confirm task state, namespace, Nomad ACLs and server-to-client connectivity.
- Provider/edition errors: check the installed Nomad edition/version and CSI/host-volume plugin capabilities.


## Verified development integration

The local ACL-enabled Nomad 2.1.1 smoke run covers real scheduling, CAS conflicts, versions/revert, scaling/restart, parameterized dispatch, periodic force, inventory pagination, variables, dynamic host-volume registration and ACL administration. Agent-browser additionally exercised HCL and JSON syntax diagnostics, semantic configuration errors, real CodeMirror variable editing and plan invalidation, file import/export and drag/drop, complete job submission, running task logs and original-source/variables reopening. The tested jobspec used variables, metadata, constraints, host networking, restart policy, a rendered template and CPU/memory/disk settings. Read-only Nomad ACL denial and configured-token redaction were also checked against the actual server; desktop/mobile visual checks remain part of verification.

Termix 26.11.0 can keep the prior backend module in memory after reinstalling the same plugin version. If source edits appear unchanged after `termix-plugin dev --once`, reload the local Termix runtime; this interrupts its active sessions. Live responses disable proxy transformations so compression does not buffer small log writes. Quiet agent monitors may not produce output until a real agent event occurs.

The isolated agent has no Docker socket, mounted host paths or public port. It cannot validate Docker task isolation, CSI/provider behavior, external OIDC login, production TLS or Enterprise policy enforcement. Those require their actual infrastructure, not mocked success.

This is a local unsigned development fork, not an official release, complete Go SDK port or embedded official UI. Restrict Termix developer mode and port access to trusted users/networks. The plugin does not install schedulers or provision remote Consul/Vault; the separate local Compose deployment described above is explicit. There is no GitOps reconciliation, production cutover or application/database HA implementation.
