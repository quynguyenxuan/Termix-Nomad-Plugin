import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { registerRoutes } from "./routes.js";
import { registerJobOperationsRoutes } from "./job-operations.js";
import { registerClusterRoutes } from "./cluster-routes.js";
import { registerAllocationRoutes, registerAllocationSockets } from "./allocation-routes.js";
import { registerStorageRoutes } from "./storage-routes.js";
import { registerAdministrationRoutes } from "./administration-routes.js";
import { registerConsulRoutes } from "./consul-routes.js";

export function activate(ctx: PluginContext): void {
  const router = ctx.http.router<Router>();
  registerRoutes(router, ctx);
  registerJobOperationsRoutes(router, ctx);
  registerClusterRoutes(router, ctx);
  registerAllocationRoutes(router, ctx);
  registerStorageRoutes(router, ctx);
  registerAdministrationRoutes(router, ctx);
  registerConsulRoutes(router, ctx);
  registerAllocationSockets(ctx);
  ctx.log.info("Nomad mounted at /plugin-api/nomad");
}

export function deactivate(): void {}
