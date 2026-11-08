import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResourceBrowser, type ResourceApi } from "../../src/frontend/ResourceUI";

afterEach(cleanup);
const columns = [{ key: "ID", title: "ID" }];
function apiWith(get: ResourceApi["get"]): ResourceApi {
  return { get, post: vi.fn(), put: vi.fn(), del: vi.fn(), fetch: vi.fn(), download: vi.fn(), url: vi.fn() };
}

describe("resource browsing", () => {
  it("navigates cursor pages and resets to the first page when filters change", async () => {
    const api = apiWith(async <T,>(_path: string, query?: Record<string, unknown>) => {
      const id = query?.prefix ? "filtered" : query?.next_token ? "second" : "first";
      return { items: [{ ID: id }], nextToken: id === "first" ? "cursor-two" : "" } as T;
    });
    render(<ResourceBrowser api={api} endpoint="/jobs" columns={columns} />);
    await screen.findByText("first");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("second");
    expect(screen.queryByText("first")).toBeNull();
    fireEvent.change(screen.getByLabelText("ID prefix"), { target: { value: "filter" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await screen.findByText("filtered");
    expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a caller's base prefix when the optional filter is cleared", async () => {
    const api = apiWith(async <T,>(_path: string, query?: Record<string, unknown>) => ({
      items: [{ ID: query?.prefix === "nomad/job-templates/" ? "template-only" : "unrelated-secret-path" }], nextToken: "",
    }) as T);
    render(<ResourceBrowser api={api} endpoint="/variables" columns={columns} query={{ prefix: "nomad/job-templates/" }} />);
    await screen.findByText("template-only");
    fireEvent.change(screen.getByLabelText("ID prefix"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByText("template-only")).toBeTruthy();
    expect(screen.queryByText("unrelated-secret-path")).toBeNull();
  });

  it("does not replace a newly selected resource with a late response", async () => {
    const late = Promise.withResolvers<unknown>();
    const api = apiWith(async <T,>(path: string) => (path === "/old" ? await late.promise : { items: [{ ID: "current" }], nextToken: "" }) as T);
    const { rerender } = render(<ResourceBrowser api={api} endpoint="/old" columns={columns} />);
    rerender(<ResourceBrowser api={api} endpoint="/new" columns={columns} />);
    await screen.findByText("current");
    late.resolve({ items: [{ ID: "stale" }], nextToken: "" });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByText("current")).toBeTruthy();
    expect(screen.queryByText("stale")).toBeNull();
  });
});
