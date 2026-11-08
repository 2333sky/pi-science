# PR #247 活动面板：改前 / 改后实拍

- 改前 `b112251fac9e67dce4b1302ec5bd70de049e2e9b`（PR #247 的父提交，即合并前的 dev）
- 改后 `ece862289aa14cd3da415f79f4f8e4c9da50074b`（PR #247 head）
- 两个独立 worktree，各自 `pnpm --filter frontend build`，用仓库自带视觉夹具（`tests/visual/fixtures/mock-server.mjs` + `data.mjs`）起服务
- 同一份夹具、同一冻结时钟 `FIXED_NOW=2026-08-15T12:00:00.000Z`、DPR 2、`locale en-US`、`timezoneId UTC`、`reducedMotion reduce`、浅色主题
- 视口：桌面 1440x900、触屏 390x844

夹具探针（只在 /tmp 的临时副本里，未进任何提交）：结算态一回合 = 用户提问 → `read data/shikimate.csv`（offset 1, limit 40）+ 结果 → `grep fold_change` + 结果 → thinking + `bash python analysis/aggregate.py` + 结果 → 最终答案（09:01:00–09:02:00，故汇总行是 `Completed · 1m00s`）；运行态 = 用户提问 → read 完成 → grep 完成 → bash 仍在运行（11:59:48–11:59:56）。

截图方式：整页截图后按元素实测矩形在 DPR 2 下裁剪（`page.screenshot` + PIL crop）。元素级 `locator.screenshot()` 在 390 宽下会被聊天的底部粘滞滚动打断，截到面板下方的答案文字；换成滚轮滚动 + 整页裁剪后稳定。鼠标在截图前移到 (4,4)，避免改后版本的汇总行 hover 底色污染对比。

| 状态 | 改前 | 改后 |
|---|---|---|
| desktop 折叠 | desktop-collapsed-before.png | desktop-collapsed-after.png |
| desktop 展开 | desktop-expanded-before.png | desktop-expanded-after.png |
| desktop 运行中 | desktop-live-before.png | desktop-live-after.png |
| mobile 折叠 | mobile-collapsed-before.png | mobile-collapsed-after.png |
| mobile 展开 | mobile-expanded-before.png | mobile-expanded-after.png |
| mobile 运行中 | mobile-live-before.png | mobile-live-after.png |

实测差异见 `measurements.json` 与 PR 评论里的对照表。
