import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { ResearchTab } from "./ResearchTab";
import { useUiStore } from "../../lib/ui";
const { newConversation } = vi.hoisted(() => ({ newConversation: vi.fn() }));
vi.mock("../sidebar/workspace-navigation", () => ({ useNewWorkspaceConversation: () => newConversation }));
vi.mock("../../lib/knowledge", () => ({ useMemoryArchives: () => ({ data: { archives: [{ id: "legacy", title: "Historical optimization", objective: "Improve accuracy", status: "running", path: "research/archives/legacy/history.json", record_count: 3 }] }, error: null }) }));
beforeAll(async () => { await i18n.changeLanguage("en"); });
it("opens saved archive files and offers conversation continuation without legacy execution controls", () => {
  const openInspector = vi.fn(); useUiStore.setState({ openInspector });
  render(<ResearchTab cwd="project" onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "research/archives/legacy/history.json" })); expect(openInspector).toHaveBeenCalledWith(expect.objectContaining({ path: "research/archives/legacy/history.json" }));
  fireEvent.click(screen.getByRole("button", { name: /Historical optimization/ })); expect(newConversation).toHaveBeenCalledWith({ draft: expect.stringContaining("/skill:auto-research Resume from the historical archive research/archives/legacy/history.json") });
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
});
