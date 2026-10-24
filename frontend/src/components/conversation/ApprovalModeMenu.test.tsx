import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApprovalModeMenu } from "./ApprovalModeMenu";
import { request } from "../../lib/client/http";
vi.mock("../../lib/client/http", () => ({ request: vi.fn(), responseError: (data: { error?: string }, fallback: string) => data.error ?? fallback }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "zh" } }) }));
const draftStore = vi.hoisted(() => ({ draftApproval: null as unknown, createNewSession: vi.fn(), setState: vi.fn() }));
vi.mock("../../lib/agent-runtime", () => ({ useRuntimeStore: { getState: () => draftStore, setState: draftStore.setState } }));
const mock = vi.mocked(request);
beforeEach(() => {
  mock.mockReset();
  draftStore.draftApproval = null; draftStore.setState.mockClear(); draftStore.createNewSession.mockClear();
  mock.mockImplementation(async (url, options) => new Response(JSON.stringify(url === "/api/settings/approval" ? { defaultMode: "ask" } : options?.method === "PUT"
    ? { mode: JSON.parse(String(options.body)).mode, revision: 1 } : { mode: "ask", revision: 0 }), { status: 200 }));
});
async function open() {
  const trigger = screen.getByRole("button", { name: "审批模式" });
  await waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.pointerDown(trigger); fireEvent.click(trigger);
  return screen.findByRole("menu");
}
it("persists automatic mode for this session", async () => {
  render(<ApprovalModeMenu cwd="/workspace" sessionId="session-a" disabled={false} />);
  await open(); fireEvent.click(screen.getByRole("menuitem", { name: /帮我批准/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "审批模式" })).toHaveTextContent("帮我批准"));
  expect(mock).toHaveBeenCalledWith(expect.stringContaining("session-a/approval-mode"), expect.objectContaining({ method: "PUT", body: expect.stringContaining('"revision":0') }));
});
it("requires an explicit full-access confirmation and supports cancellation", async () => {
  render(<ApprovalModeMenu cwd="/workspace" sessionId="session-a" disabled={false} />);
  await open(); fireEvent.click(screen.getByRole("menuitem", { name: /完全访问/ }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("用户目录");
  expect(mock.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(mock.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(0);
  await open(); fireEvent.click(screen.getByRole("menuitem", { name: /完全访问/ }));
  fireEvent.click(await screen.findByRole("button", { name: "启用完全访问" }));
  await waitFor(() => expect(mock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: expect.stringContaining('"acknowledgeFullAccess":true') })));
});
it("does not switch while a task is active and resets to the selected session's policy", async () => {
  const view = render(<ApprovalModeMenu cwd="/workspace" sessionId="session-a" disabled />);
  expect(screen.getByRole("button", { name: "审批模式" })).toBeDisabled();
  view.rerender(<ApprovalModeMenu cwd="/workspace" sessionId="session-b" disabled={false} />);
  await open();
  expect(mock).toHaveBeenCalledWith(expect.stringContaining("session-b/approval-mode"));
});
it("leaves the old mode visible when the server rejects a change", async () => {
  render(<ApprovalModeMenu cwd="/workspace" sessionId="session-a" disabled={false} />);
  await open(); mock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Stop the current task" }), { status: 409 }));
  fireEvent.click(screen.getByRole("menuitem", { name: /帮我批准/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Stop the current task");
  expect(screen.getByRole("button", { name: "审批模式" })).toHaveTextContent("请求批准");
});

it("switches ask → auto → full → ask using the latest persisted revision", async () => {
  let approval = { mode: "ask", revision: 0 };
  mock.mockImplementation(async (_url, options) => {
    if (options?.method === "PUT") {
      const input = JSON.parse(String(options.body));
      if (input.revision !== approval.revision) return new Response(JSON.stringify({ error: "Stale revision" }), { status: 409 });
      approval = { mode: input.mode, revision: approval.revision + 1 };
    }
    return new Response(JSON.stringify(approval), { status: 200 });
  });
  render(<ApprovalModeMenu cwd="/workspace" sessionId="session-a" disabled={false} />);
  await open(); fireEvent.click(screen.getByRole("menuitem", { name: /帮我批准/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "审批模式" })).toHaveTextContent("帮我批准"));
  await open(); fireEvent.click(screen.getByRole("menuitem", { name: /完全访问/ }));
  fireEvent.click(await screen.findByRole("button", { name: "启用完全访问" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "审批模式" })).toHaveTextContent("完全访问"));
  await open(); fireEvent.click(screen.getByRole("menuitem", { name: /请求批准/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "审批模式" })).toHaveTextContent("请求批准"));
  expect(approval).toEqual({ mode: "ask", revision: 3 });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("changes a blank conversation locally without creating a session or Worker", async () => {
  render(<ApprovalModeMenu cwd="/workspace" sessionId={null} disabled={false} />);
  await open(); fireEvent.click(screen.getByRole("menuitem", { name: /帮我批准/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "审批模式" })).toHaveTextContent("帮我批准"));
  expect(draftStore.setState).toHaveBeenCalledWith({ draftApproval: { cwd: "/workspace", approval: { mode: "auto", acknowledgeFullAccess: false } } });
  expect(mock.mock.calls.filter(([, options]) => options?.method)).toHaveLength(0); expect(draftStore.createNewSession).not.toHaveBeenCalled();
});
it("isolates blank drafts by workspace", async () => {
  draftStore.draftApproval = { cwd: "/workspace", approval: { mode: "full", acknowledgeFullAccess: true } };
  const view = render(<ApprovalModeMenu cwd="/workspace" sessionId={null} disabled={false} />);
  expect(screen.getByRole("button", { name: "审批模式" })).toHaveTextContent("完全访问");
  view.rerender(<ApprovalModeMenu cwd="/other" sessionId={null} disabled={false} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "审批模式" })).toHaveTextContent("请求批准"));
});

it("refreshes on focus without allowing a stale GET to roll back a successful change", async () => {
  render(<ApprovalModeMenu cwd="/workspace" sessionId="session-a" disabled={false} />);
  await open(); fireEvent.click(screen.getByRole("menuitem", { name: /帮我批准/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "审批模式" })).toHaveTextContent("帮我批准"));
  fireEvent.focus(window);
  await waitFor(() => expect(mock.mock.calls.filter(([, options]) => !options?.method)).toHaveLength(2));
  expect(screen.getByRole("button", { name: "审批模式" })).toHaveTextContent("帮我批准");
});
it("reports a runtime reset when the server retired existing capabilities", async () => {
  render(<ApprovalModeMenu cwd="/workspace" sessionId="session-a" disabled={false} />);
  await open();
  mock.mockResolvedValueOnce(new Response(JSON.stringify({ mode: "auto", revision: 1, runtimeRestarted: true })));
  fireEvent.click(screen.getByRole("menuitem", { name: /帮我批准/ }));
  expect(await screen.findByRole("status")).toHaveTextContent("内核变量已清除");
});

it("offers recovery when the target was saved but the runtime barrier could not be released", async () => {
  render(<ApprovalModeMenu cwd="/workspace" sessionId="session-a" disabled={false} />);
  await open();
  mock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Transition incomplete", data: { mode: "auto", revision: 1 } }), { status: 503 }));
  fireEvent.click(screen.getByRole("menuitem", { name: /帮我批准/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Transition incomplete");
  mock.mockResolvedValueOnce(new Response(JSON.stringify({ mode: "auto", revision: 1 })));
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(mock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: expect.stringContaining('"revision":1') })));
});

it("loads the independent default for a blank draft and permits an explicit ask override", async () => {
  mock.mockResolvedValueOnce(new Response(JSON.stringify({ defaultMode: "auto" })));
  render(<ApprovalModeMenu cwd="/workspace" sessionId={null} disabled={false} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "审批模式" })).toHaveTextContent("帮我批准"));
  await open(); fireEvent.click(screen.getByRole("menuitem", { name: /请求批准/ }));
  await waitFor(() => expect(draftStore.setState).toHaveBeenCalledWith({ draftApproval: { cwd: "/workspace", approval: { mode: "ask", acknowledgeFullAccess: false } } }));
  expect(mock.mock.calls.filter(([, options]) => options?.method)).toHaveLength(0);
});
