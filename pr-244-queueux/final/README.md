# queue-ux v3 复核（`f685e5b2` vs 改前 `1d6fcdf7`）

| 项 | 值 |
|---|---|
| 改前 | `1d6fcdf719932cefa2943465555b2e95301750bb`（`wt/queueux-before`，detached） |
| 改后 | `f685e5b23900039649896e207fe38e11b0336fda`（`wt/queue-ux`，`queue-ux-redesign`，工作树干净） |
| 本轮 diff | `frontend/src/components/conversation/ApprovalModeMenu.tsx`（`min-w-0` → `min-w-7 shrink-0`；`max-sm:hidden` → `max-lg:hidden`）、`ModelControlMenu.tsx`（档位 `max-sm:hidden` → `max-lg:hidden`），2 文件 3 行 |
| 夹具 | `frontend/tests/visual/fixtures/data.mjs`，`VISUAL_CWD=/tmp/visual-demo`，`visual-session-1`（空闲）/ `visual-running`（`is_streaming`） |
| 时钟 | `FIXED_NOW=2026-08-15T12:00:00.000Z`（`page.clock.setFixedTime`） |
| 渲染 | Chromium 1248 headless，DPR 2，en-US，Asia/Shanghai，`reducedMotion: reduce`，浅色，鼠标 (4,4)，视口高 900 |
| 队列 | `/api/sessions/*/queue` 路由拦截；运行中 2 条 `queued`；回执态见下 |

## 空闲（六档）

| 视口 | doc sw/cw | row sw/cw | 行高 | 审批 innerText | 审批 textContent | 审批 span 宽 / display | 审批按钮 | 模型名 rect/sw | 档位 span |
|---|---|---|---|---|---|---|---|---|---|
| 360 | 360/360 | 274/274 | 42 | `` | `Ask for approval` | 0.0 / none | 30.0×28 | 64.0/86（截断） | 隐藏 |
| 390 | 390/390 | 304/304 | 42 | `` | `Ask for approval` | 0.0 / none | 30.0×28 | 71.8/86（截断） | 隐藏 |
| 430 | 430/430 | 344/344 | 42 | `` | `Ask for approval` | 0.0 / none | 30.0×28 | 86.2/86（全文） | 隐藏 |
| 768 | 768/768 | 410/410 | 42 | `` | `Ask for approval` | 0.0 / none | 30.0×28 | 86.2/86（全文） | 隐藏 |
| 1024 | 1024/1024 | 666/666 | 42 | `Ask for approval` | `Ask for approval` | 93.9 / block | 127.9×28 | 86.2/86（全文） | 可见 |
| 1440 | 1440/1440 | 747/747 | 42 | `Ask for approval` | `Ask for approval` | 93.9 / block | 127.9×28 | 86.2/86（全文） | 可见 |

## 运行中（六档，`is_streaming` + 队列 2 条）

| 视口 | doc sw/cw | row sw/cw | 行高 | 工具栏行数 | Stop 行 | Stop 与发送同排 | Stop left–right | 在卡片 | 在视口 | `elementFromPoint` 命中 |
|---|---|---|---|---|---|---|---|---|---|---|
| 360 | 360/360 | 274/274 | 78 | 2 | 2 | True | 297.0–331.0 | True | True | True |
| 390 | 390/390 | 304/304 | 78 | 2 | 2 | True | 327.0–361.0 | True | True | True |
| 430 | 430/430 | 344/344 | 78 | 2 | 2 | True | 367.0–401.0 | True | True | True |
| 768 | 768/768 | 410/410 | 42 | 1 | 1 | True | 689.0–723.0 | True | True | True |
| 1024 | 1024/1024 | 666/666 | 42 | 1 | 1 | True | 945.0–979.0 | True | True | True |
| 1440 | 1440/1440 | 747/747 | 42 | 1 | 1 | True | 1193.4–1227.4 | True | True | True |

## 768 改前 / 改后

- 空闲：改前 row h 108、审批 span 宽 93.9（可见）、模型 86.2/86；改后 row h 42、审批 span `display:none` 宽 0、模型 86.2/86 全文、档位隐藏。
- 运行中：改前 2 行、Stop 行 2；改后 1 行、Stop 行 1、与发送同排 True，Stop 689.0–723.0。

## 回执态（`failed` + `dispatched/indeterminate`）

| 视口 | 面板头 | 行 1 | 行 2 | 重试按钮 | `Sent, unconfirmed` | 渲染时 toast |
|---|---|---|---|---|---|---|
| 390 | `0 queued` | Failed | Recheck the TRP row before you summarize.(policy_violation) | Sent | Sent, unconfirmed | Add a note about the assay temperature in the methods. | 有，`aria-label="Retry queued message"`，11×11 @ 335.0,640.6 | 有，87.3×16 | 无 |
| 1440 | `0 queued` | Failed | Recheck the TRP row before you summarize.(policy_violation) | Sent | Sent, unconfirmed | Add a note about the assay temperature in the methods. | 有，`aria-label="Retry queued message"`，11×11 @ 1201.4,703.0 | 有，87.3×16 | 无 |

## Toast（点「Deliver now」，dispatch 返回 `indeterminate`）

- 文案 `The message may not have reached the task.`，286×40 @ (53,27)，外层 `aria-live="polite"`，右下角关闭按钮。
- 仅在该动作返回 `indeterminate` 时出现；单纯渲染一条 `dispatched/indeterminate` 条目**不会**弹 toast（`measurements.json` 的 `receipts-390/1440.receipts.toast = null`）。

## 观察

- 回执态面板头写 `0 queued`，但列表里有 2 条（`pending` 只数 `queued`/`dispatching`）——终态条目存在时头部计数与列表不一致。
- 390 回执态 ul `clientHeight 110 / scrollHeight 120`：第 2 条底部被裁约 10px，需要滚动；1440 两条完整（72/72）。
- 重试 / 删除 / 立即投递图标均为 11×11 CSS px、无内边距，触控目标远小于 24px。
- `430` 与 `1440-running` 两张图与 v2 同名文件字节相同（`4b5035af…` / `a625710f…`），本轮改动不影响 ≥430 空闲与 1440 运行中。
