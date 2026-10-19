import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Hand, ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sessionApprovalSchema, type ApprovalMode } from "@pi-science/contracts";
import { request, responseError } from "../../lib/client/http";
import { useRuntimeStore } from "../../lib/agent-runtime";

export function ApprovalModeMenu({ cwd, sessionId, disabled }: { cwd: string; sessionId: string | null; disabled: boolean }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const [approval, setApproval] = useState<{ mode: ApprovalMode; revision: number }>({ mode: "ask", revision: 0 });
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [saving, setSaving] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const [error, setError] = useState("");
  const identity = `${cwd}\0${sessionId ?? ""}`;
  const latest = useRef(identity); latest.current = identity;
  const labels = { ask: zh ? "请求批准" : "Ask for approval", auto: zh ? "帮我批准" : "Approve safe actions", full: zh ? "完全访问" : "Full access" };
  const descriptions = {
    ask: zh ? "新增网络权限和需要审批的工具调用时询问" : "Ask for new network permissions and approval-gated tools",
    auto: zh ? "工作区内执行和公网 HTTPS；仅自动批准明确标注为安全只读的工具" : "Workspace execution and public HTTPS; auto-approve explicitly safe read-only tools",
    full: zh ? "访问用户目录文件、公网 HTTPS，并自动批准工具；禁止规则仍生效" : "Access home-directory files and public HTTPS; auto-approve tools; denials still apply",
  };
  const icons = { ask: Hand, auto: ShieldCheck, full: ShieldAlert };
  const Icon = icons[approval.mode];
  const endpoint = (id: string) => `/api/sessions/${encodeURIComponent(id)}/approval-mode?${new URLSearchParams({ cwd })}`;
  useEffect(() => {
    let cancelled = false;
    setApproval({ mode: "ask", revision: 0 }); setError(""); setConfirmFull(false); setLoading(Boolean(sessionId));
    if (sessionId) void request(endpoint(sessionId)).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(responseError(data, "Could not load approval mode"));
      const parsed = sessionApprovalSchema.parse(data);
      if (!cancelled) setApproval((current) => current.revision > parsed.revision ? current : parsed);
    }).catch((err) => { if (!cancelled) setError(String(err.message ?? err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  // The endpoint is scoped exclusively by these two values.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, sessionId]);
  const change = async (mode: ApprovalMode) => {
    if (disabled || saving || loading) return;
    const initiatingIdentity = identity;
    setSaving(true); setError("");
    try {
      const id = sessionId ?? await useRuntimeStore.getState().createNewSession();
      const res = await request(endpoint(id), { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, revision: sessionId ? approval.revision : 0, acknowledgeFullAccess: mode === "full" }) });
      const data = await res.json();
      if (!res.ok) throw new Error(responseError(data, "Could not change approval mode"));
      const parsed = sessionApprovalSchema.parse(data);
      if (latest.current === initiatingIdentity || latest.current === `${cwd}\0${id}`) setApproval(parsed);
    } catch (err) { if (latest.current === initiatingIdentity) setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); setConfirmFull(false); }
  };
  return <>
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild><button type="button" aria-label={zh ? "审批模式" : "Approval mode"} disabled={disabled || loading || saving}
        className={`flex min-h-7 items-center gap-1 rounded-input px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-50 ${approval.mode === "full" ? "text-orange-500" : "text-muted"}`}>
        <Icon size={14} /><span>{labels[approval.mode]}</span>
      </button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content onCloseAutoFocus={(event) => { if (confirmFull) event.preventDefault(); }} side="top" align="start" sideOffset={8} className="ui-popover z-[90] w-80 max-w-[calc(100vw-24px)] rounded-card p-1.5 text-text">
        <DropdownMenu.Label className="px-2 py-1 text-xs text-muted">{zh ? "当前会话的审批方式" : "Approval policy for this conversation"}</DropdownMenu.Label>
        {(["ask", "auto", "full"] as const).map((mode) => { const ItemIcon = icons[mode]; return <DropdownMenu.Item key={mode}
          onSelect={() => { if (mode !== approval.mode) { if (mode === "full") setConfirmFull(true); else void change(mode); } }}
          className={`flex cursor-default items-start gap-2 rounded-input p-2 outline-none data-[highlighted]:bg-surface-2 ${mode === "full" ? "text-orange-500" : ""}`}>
          <ItemIcon size={16} className="mt-0.5 shrink-0" /><div className="flex-1"><div className="text-sm">{labels[mode]}</div><div className="mt-0.5 text-xs opacity-75">{descriptions[mode]}</div></div>{approval.mode === mode && <Check size={15} className="mt-1 shrink-0" />}
        </DropdownMenu.Item>; })}
        <div className="px-2 py-1.5 text-[11px] text-muted">{zh ? "切换会重启运行环境并清除内核变量；任务进行中不可切换。" : "Switching restarts the runtime and clears kernel variables. Stop active tasks first."}</div>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {error && <span role="alert" className="max-w-60 text-xs text-error-text">{error}</span>}
    <Dialog.Root open={confirmFull} onOpenChange={setConfirmFull}><Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/50" />
      <Dialog.Content className="ui-popover fixed left-1/2 top-1/2 z-[101] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-card p-5 text-text">
        <Dialog.Title className="text-base font-medium">{zh ? "启用此会话的完全访问？" : "Enable full access for this conversation?"}</Dialog.Title>
        <Dialog.Description className="mt-3 text-sm text-muted">{zh ? "智能体将能够读取和修改用户目录内的文件、访问公网 HTTPS，并自动批准当前会话的工具调用。已有禁止规则、应用私有数据和受限子任务边界仍保留。切换会重启会话运行环境，清除内核变量。仅在信任本次任务时启用。" : "The agent can read and modify home-directory files, use public HTTPS, and automatically approve this conversation’s tools. Existing denials, private application data and confined-task boundaries remain protected. Switching restarts the runtime and clears kernel variables. Enable only for tasks you trust."}</Dialog.Description>
        <div className="mt-5 flex justify-end gap-3"><Dialog.Close asChild><button type="button" className="rounded-input px-3 py-1.5 text-sm">{zh ? "取消" : "Cancel"}</button></Dialog.Close><button type="button" disabled={saving || disabled} onClick={() => void change("full")} className="rounded-input bg-orange-600 px-3 py-1.5 text-sm text-white">{zh ? "启用完全访问" : "Enable full access"}</button></div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
  </>;
}
