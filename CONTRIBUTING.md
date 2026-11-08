# Developing the Nomad plugin

Use Node 24 and `npm ci --ignore-scripts`.

```bash
npm run typecheck
npm test
npm run build
npm run validate
```

For a local Termix instance with developer mode enabled, export `TERMIX_SERVER_URL` and `TERMIX_API_KEY` from a private environment file and run `npx termix-plugin dev --once`. Omit `--once` for watch mode. Reload the browser after a frontend update.

Backend code lives in `src/backend`; UI code in `src/frontend`. Tests follow the SDK convention in `tests/backend` and `tests/frontend`. Keep the HTTP mappings consistent with the official Nomad Go API, and exercise changes against an isolated real Nomad agent before claiming runtime support. Never use production hosts for smoke jobs.

Preserve host connect authorization, plugin permissions, encrypted token settings, guarded `ctx.fetch`, TLS verification, namespace/region confinement and modify-index enforcement. Do not put credentials in fixtures, errors or documentation. Keep `README.md`, `docs/index.md` and `CHANGELOG.md` aligned with behavior. Push this fork to `origin` (`quynguyenxuan/Termix-Nomad-Plugin`), not the original Docker repository at `upstream`. Registry release automation is not configured.
