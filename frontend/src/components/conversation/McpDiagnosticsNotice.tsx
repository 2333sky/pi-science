import { useTranslation } from "react-i18next";

export function McpDiagnosticsNotice({ diagnostics }: { diagnostics?: string[] }) {
  const { i18n } = useTranslation();
  if (!diagnostics?.length) return null;
  const zh = i18n.language.startsWith("zh");
  return <details role="status" className="mb-2 rounded-input border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-muted">
    <summary className="cursor-pointer">{zh ? "部分 MCP 工具未能加载，展开查看原因" : "Some MCP tools could not load. Expand for details."}</summary>
    <p className="mt-2">{zh ? "请在设置 → MCP 检查连接和所需依赖，修复配置后重试。" : "Check connections and required dependencies in Settings → MCP, then retry after fixing the configuration."}</p>
    <ul className="mt-1 list-disc space-y-1 pl-4">{diagnostics.map((message, index) => <li className="break-words" key={`${index}:${message}`}>{message}</li>)}</ul>
  </details>;
}
