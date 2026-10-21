import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { McpDiagnosticsNotice } from "./McpDiagnosticsNotice";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "zh" } }) }));
it("shows failed MCP discovery and clears the notice after recovery", () => {
  const view = render(<McpDiagnosticsNotice diagnostics={["paper-search: MCP discovery budget exceeded"]} />);
  expect(screen.getByRole("status")).toHaveTextContent("部分 MCP 工具未能加载");
  expect(screen.getByText("paper-search: MCP discovery budget exceeded")).toBeInTheDocument();
  view.rerender(<McpDiagnosticsNotice diagnostics={[]} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
