# PR #248 活动行：改前 / 改后实拍

- 改前 `b82276509e86f79549cef56e701d8c6597e9442e`（PR #248 base，`upstream/dev`）
- 改后 `8b7d9439a40d781eb8db5c0aa6176a0f2c3441ef`（PR #248 head）
- 同一 worktree `/home/agentuser/.dsh/bot/workspace/wt/activity-fixes` 就地 checkout 两个 commit；同一份临时 harness（未进任何提交，拍完删除）、同一 Chromium（playwright chromium-1248 headless）、同一视口 **1440×1000**、**DPR 2**、en、浅色与深色两种主题
- harness 固定时钟 `Date.now = 1_760_000_000_000`，两次时钟都显示 `5.0s`
- fixture：一条 `status:"running"` 的 bash 行，`input.description = "Verify the failing frontend tests and the stored expectations"`（映射到 `conversation.activity.narrative.verify.code`），`outputTruncated: true`、`originalOutputBytes: 131072`；同一份数据跑改前与改后
- 01 = 短 narrative `Verifying the changes against the stored transcript`；02 = 长 narrative `…the failing expectations and the worker checkpoints before the turn settles`
- 截图方式：`#shot` 元素截图（内容列宽 `--conversation-content-width: clamp(748px, 52vw, 1100px)` → 1440 下 748.8px，外加 16px padding），每张 **1564×232 物理像素**

| 状态 | 改前 | 改后 |
| --- | --- | --- |
| 短 narrative / 浅色 | before-01-row.png | after-01-row.png |
| 短 narrative / 深色 | before-01-row-dark.png | after-01-row-dark.png |
| 长 narrative（文本截断）/ 浅色 | before-02-row-long.png | after-02-row-long.png |

| 指标（CSS px） | 改前 | 改后 |
| --- | --- | --- |
| 行宽 rowWidth | 748.80 | 748.80 |
| 行右缘 rowRight | 1094.39 | 1094.39 |
| narrative 文本右缘 | 754.95 | 754.95 |
| 时钟左缘 / 右缘 | 1070.39 / 1094.39 | 762.95 / 786.95 |
| 时钟与文本间距 | 315.44 | **8.00** |
| 时钟之后剩余空白 | 0.00 | **307.44** |
| 剩余空白 / 行宽 | 0.00 | **0.4106** |
| 截断徽标 | 有 | 无 |

长 narrative：改前、改后 `scrollWidth 784 > clientWidth 628`，文本都在时钟前以省略号截断；注意未截断文本的 `Range` 右缘是 1218.84（被 `overflow:hidden` 裁掉），视觉上省略号停在 1062.39，时钟 1070.39 紧随其后 8px。逐字段数据见 `measurements.json`。

## 复跑命令

```bash
cd /home/agentuser/.dsh/bot/workspace/wt/activity-fixes/frontend
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
pnpm exec vite --port 5199 --strictPort   # 另开终端
PREFIX=before LONG=1 OUT_DIR=/tmp/pr248 node tests/tmp-shoot-pr248.mjs   # 在 b8227650
PREFIX=after  LONG=1 OUT_DIR=/tmp/pr248 node tests/tmp-shoot-pr248.mjs   # 在 8b7d9439
```

harness（`frontend/harness-activity.html`、`frontend/src/harness-activity-main.tsx`）与脚本（`frontend/tests/tmp-shoot-pr248.mjs`）都是临时文件，未提交，拍完即删。
