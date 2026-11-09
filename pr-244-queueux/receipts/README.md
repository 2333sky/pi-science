# queue-ux v4 — 回执态队列头文本（`3c7cfa4a` vs `f685e5b2`）

| 项 | 值 |
|---|---|
| 改前 | `f685e5b2` = `f685e5b24934b2fe9b0d4b4a6b4bb7ac2b8f2f38`（`keep the composer labels compact…`） |
| 改后 | `3c7cfa4a` = `3c7cfa4a5be87163d5c1e1c6f4ed39903a79dade`（`count receipts in the follow-up queue header`） |
| 改后 diff | `QueuedMessagesPanel.tsx` +3/−1（`const mixed = pending !== entries.length`、混合态换 `conversation.queue.summaryMixed`）、`en.json` / `zh-Hans.json` 各 +1、测试 +20 |
| 夹具 | `frontend/tests/visual/fixtures/data.mjs`，`VISUAL_CWD=/tmp/visual-demo`，会话 `visual-session-1` |
| 队列数据 | 路由拦截 `GET /api/sessions/*/queue`：1 条 `failed`（`policy_violation`）+ 1 条 `dispatched`（`error_code: "indeterminate"`，`delivered_message_id: "m-42"`） |
| 时钟 | `FIXED_NOW=2026-08-15T12:00:00.000Z`（`page.clock.setFixedTime`） |
| 渲染 | Chromium 1248 headless，DPR 2，视口 390×900 / 1440×900，en-US，Asia/Shanghai，`reducedMotion: reduce`，浅色，鼠标 (4,4) |
| 构建 | 独立 detached worktree `/tmp/q4-build`，`pnpm build` 各跑一次（均 exit 0），服务只换 `DIST_ROOT`；`wt/queue-ux` 未被改动 |
| 截图 | 按 composer 卡片 + 队列面板外接矩形在 DPR 2 下裁剪 |

## 头文本对照

| 宽度 | 改前 `textContent` | 改后 `textContent` | 改前 clientWidth/scrollWidth | 改后 clientWidth/scrollWidth | `aria-expanded` | 溢出 |
|---|---|---|---|---|---|---|
| 390 | `0 queued` | `2 messages` | 306 / 306 | 306 / 306 | `true` | 无 |
| 1440 | `0 queued` | `2 messages` | 749 / 749 | 749 / 749 | `true` | 无 |

头按钮 `aria-label` 两版都是 `Hide queued messages`；列表两行文本两版逐字相同（`Failed … (policy_violation)` / `Sent | Sent, unconfirmed …`），即**只有头文本变了**。

## 回归抽查（md5）

| 图 | 改前 | 改后 | 结论 |
|---|---|---|---|
| 390 运行中（`390-running-*.png`） | `c7d0c26cd2cedd94068dc975f7db6377` | `c7d0c26cd2cedd94068dc975f7db6377` | 字节相同，纯 `queued` 仍显示 `2 queued` |
| 768 空闲（`768-idle-*.png`） | `02654f524123fe5e0ccd33bdc0c0bd1a` | `02654f524123fe5e0ccd33bdc0c0bd1a` | 字节相同 |
| v3 的 `768-idle-after.png`（同为 `f685e5b2`） | `02654f524123fe5e0ccd33bdc0c0bd1a` | — | 与本次改前逐字节相同，流水线可复现 |
| v3 的 `390/1440-receipts-after.png`（同为 `f685e5b2`） | `767622a0…` / `d79eb327…` | — | 与本次 `*-receipts-before.png` 逐字节相同 |

## 其余结论

v3 的其余结论**仍然成立**：六档 `doc sw==cw`、运行中 `row sw==cw`、Stop 在卡片内且命中、768 空闲单行 + 审批图标化 + 模型名全文、折叠/内滚、Retry 按钮、toast 触发路径。本次按要求未重拍，唯一变化就是混合态头文本。

## 未覆盖 / 说明

- 队列与回执数据是**路由拦截**喂的 JSON，不是真 server 产生的。
- 未覆盖深色、键盘焦点、真机触控、Retry 实际重发结果。
- 390 混合态列表仍有约 10px 底部裁切（`ch 110 / sh 120`，与 v3 相同，本次未变）。
