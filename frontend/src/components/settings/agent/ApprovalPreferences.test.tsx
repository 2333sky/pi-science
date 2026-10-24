import i18n from "../../../i18n";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApprovalPreferences } from "./ApprovalPreferences";
import { request } from "../../../lib/client/http";
vi.mock("../../../lib/client/http", () => ({ request: vi.fn(), responseError: (data: { error?: string }, fallback: string) => data.error ?? fallback }));

const mock = vi.mocked(request);
beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { mock.mockReset(); mock.mockResolvedValue(new Response(JSON.stringify({ defaultMode: "ask" }))); });
it("saves only the independent new-conversation default and does not offer full access", async () => {
  render(<ApprovalPreferences />);
  const button = await screen.findByRole("button", { name: /^Default approval for new conversations:/ });
  fireEvent.pointerDown(button); fireEvent.click(button);
  expect(screen.queryByRole("menuitemradio", { name: "Full access" })).not.toBeInTheDocument();
  mock.mockResolvedValueOnce(new Response(JSON.stringify({ defaultMode: "auto" })));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Approve safe actions" }));
  await waitFor(() => expect(button).toHaveTextContent("Approve safe actions"));
  expect(mock).toHaveBeenLastCalledWith("/api/settings/approval", expect.objectContaining({ method: "PUT", body: '{"defaultMode":"auto"}' }));
});
it("keeps the saved default visible on failure", async () => {
  render(<ApprovalPreferences />);
  const button = await screen.findByRole("button", { name: /^Default approval for new conversations:/ });
  fireEvent.pointerDown(button); fireEvent.click(button);
  mock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "storage failed" }), { status: 503 }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Approve safe actions" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("storage failed");
  expect(button).toHaveTextContent("Ask for approval");
});
