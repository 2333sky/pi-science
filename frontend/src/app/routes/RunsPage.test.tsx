import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import i18n from "../../i18n";
import { queryClient } from "../../lib/client/query-client";
import type { ExecutionRecord } from "@pi-science/contracts";
import { RunsPage } from "./RunsPage";

const { toastMock, openInspectorMock, setDraftMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  openInspectorMock: vi.fn(),
  setDraftMock: vi.fn(),
}));

vi.mock("../../lib/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ui")>();
  return { ...actual, useUiStore: (selector: (state: { openInspector: typeof openInspectorMock }) => unknown) => selector({ openInspector: openInspectorMock }) };
});

vi.mock("../../lib/agent-runtime", () => ({
  useRuntimeStore: (selector: (state: { setDraft: typeof setDraftMock }) => unknown) => selector({ setDraft: setDraftMock }),
}));

vi.mock("../../lib/runs/execution-events", () => ({
  subscribeExecutionInvalidation: () => () => undefined,
}));

vi.mock("../../lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/workspace")>();
  return { ...actual, useRequiredWorkspaceCwd: () => "/workspace" };
});

vi.mock("../../components/feedback/feedback-context", () => ({
  useFeedback: () => ({ toast: toastMock }),
}));

vi.mock("../../components/layout/WorkspacePage", () => ({
  WorkspacePage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WorkspacePageHeader: ({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) => <header>{title}{description}{actions}</header>,
  WorkspacePageRefreshButton: ({ label, onClick }: { label: string; onClick: () => void }) => <button onClick={onClick}>{label}</button>,
}));

const kernelExecution: ExecutionRecord = {
  schema_version: 1,
  execution_id: "exec_kernel",
  kind: "kernel_cell",
  surface: "python",
  status: "succeeded",
  workspace_id: "/workspace",
  created_at: "2026-08-15T01:00:00.000Z",
  started_at: "2026-08-15T01:00:00.000Z",
  ended_at: "2026-08-15T01:00:02.500Z",
  producer: "node-kernel-gateway",
  correlation: { request_id: "request-1" },
  request: { notebook_id: "analysis.ipynb", code: "print('ok')\n2 + 2", language: "python" },
  runtime: { cwd: "/workspace", gateway_timeout_ms: 125_000 },
  result: { stdout_preview: "ok\n", output_preview: "4" },
  files: { read: [{ path: "data/input.csv", detection: "explicit" }], written: [{ path: "outputs/result.csv", detection: "snapshot" }] },
  artifacts: [{ artifact_id: "artifact-result", version: 2, relation: "output" }],
};

const jobExecution: ExecutionRecord = {
  schema_version: 1,
  execution_id: "exec_job",
  kind: "job",
  surface: "local",
  status: "failed",
  workspace_id: "/workspace",
  created_at: "2026-08-15T02:00:00.000Z",
  started_at: "2026-08-15T02:00:00.000Z",
  ended_at: "2026-08-15T02:00:01.000Z",
  producer: "node-job-coordinator",
  correlation: { job_id: "job_1" },
  request: { command: ["node", "train.js"] },
  runtime: { platform: "darwin" },
  result: { exit_code: 1, stderr_preview: "training failed" },
  files: { read: [], written: [] },
  artifacts: [],
};

const toolExecution: ExecutionRecord = {
  schema_version: 1,
  execution_id: "exec_tool",
  kind: "tool",
  surface: "pi",
  status: "running",
  workspace_id: "/workspace",
  created_at: "2026-08-15T03:00:00.000Z",
  started_at: "2026-08-15T03:00:00.000Z",
  producer: "agent-event-observer",
  correlation: { session_id: "session-1", tool_call_id: "call-1" },
  request: { tool: "write", input: { path: "report.md" } },
  runtime: { model: "test-model" },
  result: {},
  files: { read: [], written: [{ path: "report.md", detection: "explicit" }] },
  artifacts: [],
};

const executions = [toolExecution, jobExecution, kernelExecution];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/executions?")) {
    const params = new URL(url, "http://localhost").searchParams;
    const scoped = executions.filter((run) => !params.get("session_id") || run.correlation.session_id === params.get("session_id"));
    const filtered = scoped.filter((run) => (!params.get("kind") || run.kind === params.get("kind")) &&
      (!params.get("status") || run.status === params.get("status")) &&
      (!params.get("search") || JSON.stringify(run).toLowerCase().includes(params.get("search")!.toLowerCase())));
    const offset = Number(params.get("offset") || 0);
    return jsonResponse({ executions: filtered.slice(offset, offset + 50), total: scoped.length, filtered_total: filtered.length, offset, limit: 50 });
  }
  if (url.includes("/api/executions/exec_kernel/logs")) return jsonResponse({ stdout: "kernel stdout", stderr: "", source: "preview", complete: false });
  if (url.includes("/api/executions/exec_job/logs")) return jsonResponse({ stdout: "", stderr: "job stderr", source: "job", complete: true });
  if (url.includes("/api/executions/exec_tool/logs")) return jsonResponse({ stdout: "tool output", stderr: "", source: "preview", complete: false });
  if (url.includes("/api/artifacts/artifact-result")) return jsonResponse({ path: "outputs/result.csv" });
  return jsonResponse({ error: `unhandled ${url}` }, 404);
});

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}{location.search}</output>;
}

function SessionRunsHarness() {
  const [params] = useSearchParams();
  return <>{params.get("view") === "runs" && <RunsPage sessionId="session-1" />}<LocationProbe /></>;
}

function renderPage(initial = "/workspace/project/runs") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/workspace/:cwd/runs" element={<><RunsPage /><LocationProbe /></>} />
          <Route path="/workspace/:cwd" element={<LocationProbe />} />
          <Route path="/workspace/:cwd/session/:sessionId" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderSessionPage(initial = "/workspace/project/session/session-1?view=runs&execution=exec_tool") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/workspace/:cwd/session/:sessionId" element={<SessionRunsHarness />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  queryClient.clear();
  fetchMock.mockClear();
  toastMock.mockClear();
  openInspectorMock.mockClear();
  setDraftMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RunsPage execution ledger", () => {
  it("selects the newest execution and stores the selection in the URL", async () => {
    renderPage();

    await screen.findAllByText("write");
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("execution=exec_tool"));
    expect(screen.getByTestId("runs-workbench")).toHaveAttribute("data-compact-detail", "false");
    expect(screen.getByTestId("runs-workbench").parentElement).toHaveClass("runs-workbench-container");
    expect(screen.getByText("agent-event-observer")).toBeInTheDocument();
    expect(screen.getAllByText("Running", { selector: "dd" }).length).toBeGreaterThan(0);
  });

  it("honors a deep-linked selection and updates it when another row is selected", async () => {
    renderPage("/workspace/project/runs?execution=exec_job");

    await screen.findByText("node-job-coordinator");
    expect(screen.getByText("Failed", { selector: "dd" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /analysis\.ipynb/ }));
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("execution=exec_kernel"));
    expect(screen.getByTestId("runs-workbench")).toHaveAttribute("data-compact-detail", "true");
    expect(screen.getByText("node-kernel-gateway")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to executions" }));
    expect(screen.getByTestId("runs-workbench")).toHaveAttribute("data-compact-detail", "false");
  });

  it("filters by search text, kind, and status", async () => {
    renderPage();
    await screen.findAllByText("write");

    fireEvent.change(screen.getByLabelText("Search executions"), { target: { value: "result.csv" } });
    expect(await screen.findByRole("button", { name: /analysis\.ipynb/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /node train\.js/ })).toBeNull());

    fireEvent.change(screen.getByLabelText("Search executions"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter by execution type"), { target: { value: "job" } });
    expect(await screen.findByRole("button", { name: /node train\.js/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "succeeded" } });
    expect(await screen.findByText("No matching executions")).toBeInTheDocument();
  });

  it("shows input, files, artifacts, timing, and lazily loaded output", async () => {
    renderPage("/workspace/project/runs?execution=exec_kernel");
    await screen.findByText("node-kernel-gateway");

    fireEvent.click(screen.getByRole("tab", { name: "Input" }));
    expect(screen.getAllByText(/print\('ok'\)/, { selector: "pre" })[0]).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByText("data/input.csv")).toBeInTheDocument();
    expect(screen.getByText("outputs/result.csv")).toBeInTheDocument();
    expect(screen.getByText("artifact-result")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Timing" }));
    expect(screen.getAllByText("2.5 s").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Output" }));
    expect(await screen.findByText("kernel stdout")).toBeInTheDocument();
    expect(screen.getByText(/earlier output may have been truncated/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/executions/exec_kernel/logs"), expect.anything());
  });

  it("opens recorded files and resolves artifacts to their workspace file", async () => {
    renderPage("/workspace/project/runs?execution=exec_kernel");
    await screen.findByText("node-kernel-gateway");
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    fireEvent.click(screen.getByRole("button", { name: /outputs\/result\.csv/ }));
    expect(openInspectorMock).toHaveBeenCalledWith(expect.objectContaining({ variant: "file", path: "outputs/result.csv", cwd: "/workspace" }));

    fireEvent.click(screen.getByRole("button", { name: /artifact-result/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/artifacts/artifact-result"), expect.anything()));
    expect(openInspectorMock).toHaveBeenLastCalledWith(expect.objectContaining({ path: "outputs/result.csv" }));
  });

  it("copies execution evidence and drafts a reproduction in the originating session", async () => {
    renderPage("/workspace/project/runs?execution=exec_tool");
    await screen.findByText("agent-event-observer");

    fireEvent.click(screen.getByRole("button", { name: "Copy ID" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("exec_tool"));
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("write"));

    fireEvent.click(screen.getByRole("button", { name: "Ask AI to attempt reproduction" }));
    expect(setDraftMock).toHaveBeenCalledWith(expect.stringContaining("exec_tool"));
    expect(screen.getByLabelText("location")).toHaveTextContent("/workspace/%2Fworkspace/session/session-1");
  });

  it("locates correlated tool executions instead of offering a redundant session link", async () => {
    renderSessionPage();
    await screen.findByText("agent-event-observer");

    expect(screen.queryByRole("button", { name: "Open session" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Locate in conversation" }));

    await waitFor(() => {
      const location = screen.getByLabelText("location");
      expect(location).toHaveTextContent("focus=tool-call-1");
      expect(location).not.toHaveTextContent("view=runs");
      expect(location).not.toHaveTextContent("execution=");
    });
  });

  it("offers the session kernel from execution records only when kernel cells exist", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ executions: [{ ...kernelExecution, correlation: { session_id: "session-1" } }], total: 1, filtered_total: 1 }));
    renderSessionPage("/workspace/project/session/session-1?view=runs&execution=exec_kernel");
    const button = await screen.findByRole("button", { name: "Open session kernel" });

    fireEvent.click(button);

    expect(openInspectorMock).toHaveBeenCalledWith({ variant: "notebook-panel" });
  });

  it("surfaces failure evidence without requiring the output tab", async () => {
    renderPage("/workspace/project/runs?execution=exec_job");
    expect(await screen.findByText("Execution problem")).toBeInTheDocument();
    expect(screen.getAllByText("training failed")[0]).toBeInTheDocument();
    expect(screen.getByText(/exit code 1/)).toBeInTheDocument();
  });
});


describe("execution scope and timeline", () => {
  it("keeps session URL scope, allows workspace records, then restores the session", async () => {
    renderPage("/workspace/project/runs?session_id=session-1");
    await screen.findByText("agent-event-observer");
    expect(screen.queryByRole("button", { name: /node train\.js/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Execution scope")).toHaveValue("session");
    fireEvent.change(screen.getByLabelText("Execution scope"), { target: { value: "workspace" } });
    await screen.findByRole("button", { name: /node train\.js/ });
    expect(screen.getByLabelText("location")).toHaveTextContent("scope=workspace");
    expect(screen.getByLabelText("location")).toHaveTextContent("session_id=session-1");
    fireEvent.change(screen.getByLabelText("Execution scope"), { target: { value: "session" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: /node train\.js/ })).not.toBeInTheDocument());
  });

  it("defaults workspace entry to all records and links timeline selections to details", async () => {
    renderPage();
    await screen.findByText("agent-event-observer");
    expect(screen.getByLabelText("Execution scope")).toHaveValue("workspace");
    fireEvent.change(screen.getByLabelText("Browse executions"), { target: { value: "timeline" } });
    expect(screen.getByLabelText("Execution timeline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /node train\.js/ }));
    await screen.findByText("node-job-coordinator");
    expect(screen.getByLabelText("location")).toHaveTextContent("execution=exec_job");
  });

  it("requests older pages and resets paging when search changes", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ executions: Array.from({ length: 50 }, (_, index) => ({ ...toolExecution, execution_id: `exec-page-${index}` })), total: 125, filtered_total: 125 }));
    renderPage();
    await screen.findByText("agent-event-observer");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("offset=50"), expect.anything()));
    fireEvent.change(screen.getByLabelText("Search executions"), { target: { value: "result.csv" } });
    await screen.findByRole("button", { name: /analysis\.ipynb/ });
    const lastListCall = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/executions?" )).at(-1);
    expect(String(lastListCall?.[0])).toContain("offset=0");
    expect(String(lastListCall?.[0])).toContain("search=result.csv");
  });

  it("submits time bounds to the server and rejects a reversed range", async () => {
    renderPage();
    await screen.findByText("agent-event-observer");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-15T01:00" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("from="), expect.anything()));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-14T01:00" } });
    expect(screen.getByRole("alert")).toHaveTextContent("end time must be after");
  });
});
