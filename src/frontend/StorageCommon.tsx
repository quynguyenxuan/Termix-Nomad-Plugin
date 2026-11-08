import React from "react";
import { Button, Input, Textarea } from "@termix-ssh/plugin-sdk/ui";
import { useRefreshTick, type PageProps, type ResourceApi } from "./ResourceUI";

export type StorageApi = ResourceApi;
export type RecordValue = Record<string, unknown>;
export const fieldClass = "flex min-w-0 flex-col gap-1 text-sm";
export const selectClass = "h-9 rounded-md border border-input bg-background px-3 text-sm";
export function text(value: unknown): string { return value == null ? "-" : typeof value === "object" ? JSON.stringify(value) : String(value); }
export function records(value: unknown): RecordValue[] { return Array.isArray(value) ? value.filter((item): item is RecordValue => !!item && typeof item === "object" && !Array.isArray(item)) : []; }
export function Fields({ value, names }: { value: RecordValue; names: string[] }) {
  return <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{names.map(name => <div key={name} className="min-w-0"><dt className="text-sm text-muted-foreground">{name.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd className="break-words text-sm">{text(value[name])}</dd></div>)}</dl>;
}
export function StorageTable({ rows, columns }: { rows: RecordValue[]; columns: string[] }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{columns.map(column => <th key={column} className="p-2">{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.ID ?? index)}>{columns.map(column => <td className="break-words border-t p-2" key={column}>{text(row[column])}</td>)}</tr>)}</tbody></table>{!rows.length && <p className="p-2 text-sm text-muted-foreground">No entries.</p>}</div>;
}
export function useStorageDetail<T>(api: StorageApi, path: string, query?: Record<string, string>, postBody?: RecordValue) {
  const [loaded, setLoaded] = React.useState<{ key: string; value: T }>();
  const [error, setError] = React.useState<unknown>();
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  const tick = useRefreshTick();
  const queryKey = JSON.stringify(query ?? {});
  const bodyKey = postBody === undefined ? undefined : JSON.stringify(postBody);
  const key = `${path}:${queryKey}:${bodyKey ?? ""}`;
  React.useEffect(() => {
    let active = true;
    setError(undefined);
    if (!path) { setLoaded(undefined); return; }
    const request = bodyKey === undefined ? api.get<T>(path, JSON.parse(queryKey)) : api.post<T>(path, JSON.parse(bodyKey));
    request.then(result => { if (active) setLoaded({ key, value: result }); }).catch(cause => { if (active) setError(cause); });
    return () => { active = false; };
  }, [api, path, queryKey, bodyKey, key, revision, tick]);
  return { value: loaded?.key === key ? loaded.value : undefined, error, refresh };
}
export function Links({ allocations, onNavigate }: { allocations: unknown; onNavigate: PageProps["onNavigate"] }) {
  return <div className="flex flex-wrap gap-2">{records(allocations).map(allocation => <Button key={text(allocation.ID)} variant="outline" onClick={() => onNavigate("allocations", text(allocation.ID), typeof allocation.Namespace === "string" ? allocation.Namespace : undefined)}>{text(allocation.Name ?? allocation.ID)}: {text(allocation.ClientStatus)}</Button>)}</div>;
}
export function StringItems({ value, onChange, disabled = false }: { value: [string, string][]; onChange: (value: [string, string][]) => void; disabled?: boolean }) {
  return <div className="space-y-3">{value.map(([key, item], index) => <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-[minmax(8rem,1fr)_minmax(8rem,2fr)_auto]" key={index}>
    <label className={fieldClass}>Item key {index + 1}<Input aria-label={`Item key ${index + 1}`} value={key} disabled={disabled} onChange={event => onChange(value.map((entry, i) => i === index ? [event.target.value, entry[1]] : entry))} /></label>
    <label className={fieldClass}>Item value {index + 1}<Textarea aria-label={`Item value ${index + 1}`} value={item} disabled={disabled} rows={3} onChange={event => onChange(value.map((entry, i) => i === index ? [entry[0], event.target.value] : entry))} /></label>
    <Button type="button" variant="outline" disabled={disabled} onClick={() => onChange(value.filter((_, i) => i !== index))}>Remove item {index + 1}</Button>
  </div>)}<Button type="button" variant="outline" disabled={disabled} onClick={() => onChange([...value, ["", ""]])}>Add item</Button></div>;
}
export function itemMap(items: [string, string][]): Record<string, string> {
  if (!items.length || items.some(([key]) => !key.trim()) || new Set(items.map(([key]) => key)).size !== items.length) throw new Error("Provide at least one item with a nonempty, unique key.");
  return Object.fromEntries(items);
}
export function AdvancedJson({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <details><summary className="cursor-pointer text-sm">{label}</summary><Textarea className="mt-2 font-mono text-xs" aria-label={label} rows={8} value={value} onChange={event => onChange(event.target.value)} /></details>;
}
export function jsonObject(source: string): RecordValue {
  const value: unknown = JSON.parse(source || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Advanced specification must be a JSON object.");
  return value as RecordValue;
}
