import { resolve } from "node:path";

// Dispatch admission, not a second copy of mode/revision authority. Shared by
// the session coordinator and trusted kernel gateways in the control plane.
const blocked = new Set<string>();
const key = (cwd: string, sessionId: string) => `${resolve(cwd)}\0${sessionId}`;
export const beginApprovalTransition = (cwd: string, sessionId: string) => { blocked.add(key(cwd, sessionId)); };
export const finishApprovalTransition = (cwd: string, sessionId: string) => { blocked.delete(key(cwd, sessionId)); };
export function assertApprovalDispatchAvailable(cwd: string, sessionId: string) {
  if (blocked.has(key(cwd, sessionId))) throw new Error("Approval transition blocks capability dispatch; retry after revocation completes");
}
