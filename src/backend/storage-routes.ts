import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { identifier, NomadClient, NomadError, nonnegativeInteger } from "./client.js";
import { route, objectBody, listQuery, id, scoped } from "./route-utils.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown, label = "object"): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NomadError(400, `Invalid ${label}`);
  return value as ObjectValue;
}
function list(value: unknown): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new NomadError(502, "Invalid Nomad list response");
  return value;
}
function strings(value: unknown): Record<string, string> {
  const items = object(value, "string map");
  if (Object.entries(items).some(([key, item]) => !key || typeof item !== "string")) throw new NomadError(400, "Items must have nonempty keys and string values");
  return items as Record<string, string>;
}
function variablePath(value: unknown): string {
  const path = identifier(value, "variable path");
  if (path.startsWith("/") || path.endsWith("/") || path.split("/").some(segment => !segment || segment === "." || segment === "..")) throw new NomadError(400, "Variable path must contain nonempty relative segments");
  return path;
}
function varURL(path: string): string { return `/v1/var/${path.split("/").map(encodeURIComponent).join("/")}`; }
function cas(value: unknown): number {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) value = Number(value);
  return nonnegativeInteger(value, "CAS index");
}
function scopedInput(value: unknown, ns: string, region: string): ObjectValue {
  const input = object(value, "volume specification");
  if (input.Namespace != null && input.Namespace !== ns) throw new NomadError(400, "Volume namespace must match the selected namespace");
  if (input.Region != null && input.Region !== region) throw new NomadError(400, "Volume region must match the configured region");
  const { Region: _region, ...spec } = input;
  return { ...spec, Namespace: ns };
}
async function volume(client: NomadClient, ns: string, kind: "csi" | "host", encodedID: string): Promise<ObjectValue> {
  return scoped(await client.request(`/v1/volume/${kind}/${encodedID}`, ns), ns, decodeURIComponent(encodedID));
}
async function registrations(client: NomadClient, ns: string, name: string): Promise<ObjectValue[]> {
  return list(await client.request(`/v1/service/${name}`, ns)).map(value => {
    const item = scoped(value, ns);
    if (item.ServiceName !== decodeURIComponent(name)) throw new NomadError(409, "Service identity mismatch");
    return item;
  });
}
function checkedVariable(value: unknown, ns: string, path: string): ObjectValue {
  const result = scoped(value, ns);
  if (result.Path !== path) throw new NomadError(409, "Variable path mismatch");
  return result;
}

export function registerStorageRoutes(router: Router, ctx: PluginContext): void {
  const root = "/hosts/:hostId";
  router.get(`${root}/services`, route(ctx, async (_req, client, ns) => list(await client.request("/v1/services", ns)).flatMap(value => {
    const group = scoped(value, ns);
    return list(group.Services).map(service => ({ ...object(service), Namespace: group.Namespace }));
  })));
  router.get(`${root}/services/:serviceName`, route(ctx, async (req, client, ns) => registrations(client, ns, id(req, "serviceName")), "use", true));
  router.delete(`${root}/services/:serviceName/:serviceId`, route(ctx, async (req, client, ns) => {
    const name = id(req, "serviceName");
    const registrationId = id(req, "serviceId");
    const items = await registrations(client, ns, name);
    if (!items.some(item => item.ID === decodeURIComponent(registrationId))) throw new NomadError(404, "Service registration not found");
    return client.request(`/v1/service/${name}/${registrationId}`, ns, { method: "DELETE" });
  }, "manage", true));
  router.get(`${root}/services/:serviceName/:serviceId/checks`, route(ctx, async (req, client, ns) => {
    const items = await registrations(client, ns, id(req, "serviceName"));
    const registration = items.find(item => item.ID === decodeURIComponent(id(req, "serviceId")));
    if (!registration) throw new NomadError(404, "Service registration not found");
    const allocationID = identifier(registration.AllocID, "allocation ID");
    scoped(await client.request(`/v1/allocation/${encodeURIComponent(allocationID)}`, ns), ns, allocationID);
    return client.request(`/v1/client/allocation/${encodeURIComponent(allocationID)}/checks`, ns);
  }, "use", true));

  for (const kind of ["csi", "host"] as const) {
    const endpoint = `${root}/${kind}-volumes`;
    router.get(endpoint, route(ctx, async (req, client, ns) => {
      const page = await client.page("/v1/volumes", ns, { ...listQuery(req), type: kind });
      return { ...page, items: page.items.map(item => scoped(item, ns)) };
    }));
    router.get(`${endpoint}/:volumeId`, route(ctx, async (req, client, ns) => volume(client, ns, kind, id(req, "volumeId")), "use", true));
    for (const operation of ["create", "register"] as const) {
      router.post(`${endpoint}/${operation}`, route(ctx, async (req, client, ns) => {
        const spec = scopedInput(objectBody(req).Volume, ns, client.region);
        identifier(spec.Name, "volume name");
        if (kind === "csi") {
          const volumeID = identifier(spec.ID, "volume ID");
          identifier(spec.PluginID, "plugin ID");
          return client.request(`/v1/volume/csi/${encodeURIComponent(volumeID)}${operation === "create" ? "/create" : ""}`, ns, { method: "PUT", body: { Volumes: [spec] } });
        }
        if (operation === "register") {
          identifier(spec.NodeID, "node ID");
          identifier(spec.HostPath, "host path");
        }
        return client.request(`/v1/volume/host/${operation}`, ns, { method: "PUT", body: { Volume: spec } });
      }, "manage", true));
    }
    router.delete(`${endpoint}/:volumeId`, route(ctx, async (req, client, ns) => {
      const volumeID = id(req, "volumeId");
      await volume(client, ns, kind, volumeID);
      if (req.query.force !== undefined && req.query.force !== "true" && req.query.force !== "false") throw new NomadError(400, "Force must be true or false");
      return client.request(`/v1/volume/${kind}/${volumeID}`, ns, { method: "DELETE", query: { force: req.query.force === "true" ? "true" : "false" } });
    }, "manage", true));
  }
  router.post(`${root}/csi-volumes/:volumeId/delete`, route(ctx, async (req, client, ns) => {
    const item = await volume(client, ns, "csi", id(req, "volumeId"));
    const externalID = identifier(item.ExternalID, "external volume ID");
    const input = objectBody(req);
    return client.request(`/v1/volume/csi/${encodeURIComponent(externalID)}/delete`, ns, { method: "DELETE", csiSecrets: input.Secrets === undefined ? {} : strings(input.Secrets) });
  }, "manage", true));
  router.post(`${root}/csi-volumes/:volumeId/expand`, route(ctx, async (req, client, ns) => {
    const volumeID = id(req, "volumeId");
    const current = await volume(client, ns, "csi", volumeID);
    const input = objectBody(req);
    const min = nonnegativeInteger(input.RequestedCapacityMin, "Minimum capacity");
    const max = nonnegativeInteger(input.RequestedCapacityMax, "Maximum capacity");
    if (!min || (max && max < min) || (typeof current.Capacity === "number" && min < current.Capacity)) throw new NomadError(400, "Expansion cannot shrink a volume and maximum must be zero or at least minimum");
    const spec = { ...current, RequestedCapacityMin: min, RequestedCapacityMax: max, ...(input.Secrets === undefined ? {} : { Secrets: strings(input.Secrets) }) };
    return client.request(`/v1/volume/csi/${volumeID}`, ns, { method: "PUT", body: { Volumes: [spec] } });
  }, "manage", true));
  router.get(`${root}/csi-plugins`, route(ctx, async (req, client, ns) => client.page("/v1/plugins", ns, { ...listQuery(req), type: "csi" })));
  router.get(`${root}/csi-plugins/:pluginId`, route(ctx, async (req, client, ns) => {
    const pluginID = id(req, "pluginId");
    const result = object(await client.request(`/v1/plugin/csi/${pluginID}`, ns));
    if (result.ID !== decodeURIComponent(pluginID)) throw new NomadError(409, "Plugin identity mismatch");
    return result;
  }));
  router.get(`${root}/csi-volumes/:volumeId/snapshots`, route(ctx, async (req, client, ns) => {
    const item = await volume(client, ns, "csi", id(req, "volumeId"));
    const query = listQuery(req);
    const result = object(await client.request("/v1/volumes/snapshot", ns, { query: { plugin_id: identifier(item.PluginID, "plugin ID"), per_page: query.per_page ?? "50", ...(query.next_token ? { next_token: query.next_token } : {}) } }));
    return { items: list(result.Snapshots).filter(value => object(value).ExternalSourceVolumeID === item.ExternalID), nextToken: typeof result.NextToken === "string" ? result.NextToken : "" };
  }, "use", true));
  router.post(`${root}/csi-volumes/:volumeId/snapshots/list`, route(ctx, async (req, client, ns) => {
    const item = await volume(client, ns, "csi", id(req, "volumeId"));
    const input = objectBody(req);
    const nextToken = input.nextToken === undefined || input.nextToken === "" ? "" : identifier(input.nextToken, "snapshot cursor");
    const secrets = input.Secrets === undefined ? {} : strings(input.Secrets);
    const result = object(await client.request("/v1/volumes/snapshot", ns, { query: { plugin_id: identifier(item.PluginID, "plugin ID"), per_page: "50", ...(nextToken ? { next_token: nextToken } : {}) }, csiSecrets: secrets }));
    return { items: list(result.Snapshots).filter(value => object(value).ExternalSourceVolumeID === item.ExternalID), nextToken: typeof result.NextToken === "string" ? result.NextToken : "" };
  }, "use", true));
  router.post(`${root}/csi-volumes/:volumeId/snapshots`, route(ctx, async (req, client, ns) => {
    const item = await volume(client, ns, "csi", id(req, "volumeId"));
    const input = objectBody(req);
    const Secrets = input.Secrets === undefined ? {} : strings(input.Secrets);
    const snapshot = { Name: identifier(input.Name, "snapshot name"), SourceVolumeID: item.ID, PluginID: item.PluginID, Secrets, Parameters: input.Parameters === undefined ? {} : strings(input.Parameters) };
    return client.request("/v1/volumes/snapshot", ns, { method: "PUT", body: { Snapshots: [snapshot] }, csiSecrets: Secrets });
  }, "manage", true));
  router.post(`${root}/csi-volumes/:volumeId/snapshots/delete`, route(ctx, async (req, client, ns) => {
    const item = await volume(client, ns, "csi", id(req, "volumeId"));
    const input = objectBody(req);
    const snapshotID = identifier(input.ID, "snapshot ID");
    const pluginID = identifier(item.PluginID, "plugin ID");
    const secrets = input.Secrets === undefined ? {} : strings(input.Secrets);
    const nextToken = input.nextToken === undefined ? "" : identifier(input.nextToken, "snapshot cursor");
    const result = object(await client.request("/v1/volumes/snapshot", ns, { query: { plugin_id: pluginID, next_token: nextToken, per_page: "50" }, csiSecrets: secrets }));
    if (!list(result.Snapshots).some(value => { const snapshot = object(value); return snapshot.ID === snapshotID && snapshot.ExternalSourceVolumeID === item.ExternalID; })) throw new NomadError(409, "Snapshot does not belong to this volume or is absent from the selected provider page");
    return client.request("/v1/volumes/snapshot", ns, { method: "DELETE", query: { plugin_id: pluginID, snapshot_id: snapshotID }, csiSecrets: secrets });
  }, "manage", true));

  router.get(`${root}/variables`, route(ctx, async (req, client, ns) => {
    const page = await client.page("/v1/vars", ns, listQuery(req));
    return { ...page, items: page.items.map(value => {
      const item = scoped(value, ns);
      return { Path: item.Path, Namespace: item.Namespace, CreateIndex: item.CreateIndex, ModifyIndex: item.ModifyIndex, CreateTime: item.CreateTime, ModifyTime: item.ModifyTime };
    }) };
  }));
  router.get(`${root}/variable`, route(ctx, async (req, client, ns) => {
    const path = variablePath(req.query.path);
    return checkedVariable(await client.request(varURL(path), ns), ns, path);
  }, "use", true));
  router.put(`${root}/variable`, route(ctx, async (req, client, ns) => {
    const input = objectBody(req);
    const path = variablePath(input.Path);
    if (input.Namespace !== undefined && input.Namespace !== ns) throw new NomadError(400, "Variable namespace must match the selected namespace");
    const index = nonnegativeInteger(input.ModifyIndex, "CAS index");
    const Items = strings(input.Items);
    if (index > 0) checkedVariable(await client.request(varURL(path), ns), ns, path);
    return checkedVariable(await client.request(varURL(path), ns, { method: "PUT", body: { Path: path, Namespace: ns, Items }, query: { cas: String(index) } }), ns, path);
  }, "manage", true));
  router.delete(`${root}/variable`, route(ctx, async (req, client, ns) => {
    const path = variablePath(req.query.path);
    const index = cas(req.query.cas);
    if (!index) throw new NomadError(400, "Deleting a variable requires its nonzero CAS index");
    checkedVariable(await client.request(varURL(path), ns), ns, path);
    return client.request(varURL(path), ns, { method: "DELETE", query: { cas: String(index) } });
  }, "manage", true));
}
