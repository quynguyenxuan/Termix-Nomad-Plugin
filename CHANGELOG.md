# Changelog

## 1.3.1

### Added

- Add a separately configured, validated Nomad UI link beside the Consul UI link in cluster headers and Consul-backed job details, including Nomad-only access without Consul.
- Publish the local Nomad UI/API port only on the host's Tailscale address while retaining Nomad ACL authentication; never put tokens into browser URLs.

## 1.3.0

### Added

- Show separately configured Consul API reachability and a validated browser URL in the Nomad cluster header.
- Show allocation-scoped Consul service checks, output and aggregate health in job details without mixing them into the native Nomad service catalog.
- Use a separate encrypted read-only Consul token; validate Nomad job/allocation ownership before reading Consul and filter checks before serialization.
- Keep missing, incomplete, ACL-filtered and unavailable data unknown; preserve known critical/warning service or associated-node health without exposing unrelated checks.
- Add a persistent ACL-enabled local Consul deployment, Nomad workload-identity configuration and a private Consul-backed HTTP demo.

## 1.2.0

### Added

- Complete native Run Job workflow with CodeMirror HCL/JSON editing, variable values, source/variable file import and export, drag and drop, and word wrapping.
- Add explicit authoritative syntax and full configuration validation, driver-validation status, canonical JSON inspection/export, and scheduler dry-run review with placement, warnings and preemptions.
- Preserve the original job specification and HCL variables with CAS submissions; reopen the version-specific source for editing without losing the expanded JSON editing option.

### Fixed

- Keep useful bounded parser/validation diagnostics and line/column locations while redacting connection credentials and rejecting proxy HTML.
- Invalidate validation and deployment plans on edits or scope changes, and discard stale file, API and source-loading results.
- Preserve unrestricted jobspec fields, leaving edition and driver support checks to the configured Nomad cluster instead of rejecting multiregion configuration in the client.

## 1.1.0

### Added

- Replace the limited jobs view with native cluster/topology, jobs/scheduling, allocation/task, services/storage/variables and administration navigation.
- Add Nomad to the main navigation with an account-scoped cluster selector, setup guidance for empty accounts and workspace isolation when switching or losing access to a cluster.
- Add authenticated live logs/monitoring, bounded filesystem downloads and xterm exec through fixed-endpoint WebSockets with separate execution authorization.
- Add node/pool management, job history/dispatch/rollout actions, variable CAS, CSI/snapshot/dynamic host-volume operations and namespace/ACL administration forms.
- Separate use, workload management, execution and administration permissions; retain host connect checks, encrypted credentials, verified TLS, namespace identity checks and explicit destructive confirmations.
- Add cursor/filter/search controls, refresh preserving dirty editors and sessions, and cancellation on connection/scope changes.

### Fixed

- Use Nomad's uppercase `OIDC`/`JWT` wire types for authentication methods.
- Pin WebSocket address families correctly on Node 24 and decode omitted zero exit codes.
- Prevent response transformations from buffering live log and monitor streams.

## 1.0.0

### Added

- Fork Termix Docker plugin at `0acff64b737600d9c8c4565ea94a302222b42c78` as a separate local Nomad plugin; retain its Apache-2.0 license.
- Replace Docker SSH, Compose, container consoles and translations with a Nomad HTTP client and host-scoped jobs UI.
- Implement selected protocols from the official Nomad Go API: namespace/job/node inventory, allocation details and finite task logs, HCL/JSON parsing, plan, CAS registration, task-group scale and nonpurging stop.
- Use Termix encrypted host settings, connect authorization, use/manage permissions and guarded outbound HTTP; keep cluster credentials backend-only.
- Remove Docker-specific dependencies, hooks and publishing automation. Keep the existing Docker plugin untouched in Termix.
