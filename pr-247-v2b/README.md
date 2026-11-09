# PR #247 新 head `ec4cc244` 复核：活动面板文本有没有变

**结论：`identical`。** 在 v2 的同一批条件（`visual-session-1` 收起/展开、`visual-running`、1440 与 390）下，`ec69c81d → ec4cc244` 的活动面板逐行文本、行高、图标、可点区宽度**完全一致**（8 个状态里 6 个 JSON 逐字段相同）。`shots/pr247-v2/` 继续有效，不需要替换任何一张图。

变的是**这三次提交覆盖到的输入**（v2 夹具里没有这些输入）：见下面的 edge 会话。

## 环境与命令

- 改前 `ec69c81d0e56d074801b3c7b95c691955ca2e9ec`｜改后 `ec4cc24465393e5414b0ba784e67df1b2f404c17`
- 两侧都在独立 detached worktree（`/tmp/p2`、`/tmp/p3`），未写 `wt/up-act`；`node_modules` 为拷贝，无仓库内改动
- 构建：`cd /tmp/p2 && pnpm --filter frontend build`（exit 0）、`cd /tmp/p3 && pnpm --filter frontend build`（exit 0）
- 渲染：探针 server（`/tmp/pr247v3/server-{old,new}.mjs`，由仓库的 `frontend/tests/visual/fixtures/mock-server.mjs` 改写，dist 由 `DIST_ROOT` 指定）跑在 4177（旧）/4178（新），Playwright Chromium 1248，DPR 2，`FIXED_NOW=2026-08-15T12:00:00.000Z`，`VISUAL_CWD=/tmp/visual-demo`，en-US / Asia/Shanghai / `reducedMotion: reduce` / 浅色
- 视口 1440（鼠标）与 390（`hasTouch`），每个状态抓 `摘要文本 + 每行 {text, title, glyph, rect, duration, font}`，两侧逐字段比对

## 比对结果

| 状态 | 面板高 | 结论 |
| --- | --- | --- |
| 1440 收起 | 45 | 逐字段相同 |
| 1440 展开（read/search/run/notebook） | 203 | 逐字段相同 |
| 1440 运行中 | — | 逐字段相同 |
| 390 收起 | 49 | 逐字段相同 |
| 390 展开 | 223 | 逐字段相同 |
| 390 运行中 | — | 逐字段相同 |
| 1440 edge（探针新增输入） | 270 | **4 行文本变化** |
| 390 edge（探针新增输入） | 298 | **4 行文本变化** |

## edge 会话：这三次改动到底影响什么

探针在 `visual-edge` 里造了这几种输入（v2 夹具里没有），同一份数据跑两版：

| # | 输入 | 旧 `ec69c81d` | 新 `ec4cc244` | bbox 旧 → 新（1440） |
| --- | --- | --- | --- | --- |
| 1 | `read {path, offset:1, limit:40}` + 服务端 `presentation.title = "Reading data/shikimate.csv rows 1-40"` | `Reading shikimate.csv:1-40` | `Reading data/shikimate.csv rows 1-40` | 245.8 → 311.0 宽 |
| 2 | `grep {pattern:"shikimate", path:"data/shikimate.csv"}`（无服务端 title） | `Searching for shikimate.csv` | `Searching for shikimate` | 246.6 → 220.7 |
| 3 | `grep {pattern:"needle", path:"src/deep/file.ts"}` + `presentation.title = "Searching for needle in src/"` | `Searching for file.ts` | `Searching for needle in src/` | 195.6 → 245.4 |
| 4 | `grep {pattern: 60×😀}`（超长，触发 trim） | `Searching for ` + 39×😀 + **孤立代理字符 `U+D83D`** + `…` | `Searching for ` + 60×😀（码点 60 ≤ 80，不截断） | 510.4 → 510.4（视觉都被 CSS 截断） |

- 行高、图标、行左缘 x：所有 edge 行两版一致（1440 行高 36、x491.6；390 行高 40、x84）。
- 面板高 270 / 298 两版一致；`docSW == docCW` 全部成立。
- 第 4 行是本次 `trim()` 改动的直接证据：旧版按 UTF-16 单元截断，标签里真的留下了未配对的 `U+D83D`，浏览器渲染成 `�`；新版按码点截断，没有残缺字符。

## 对你那 22 张 v2 图的影响

- **不需要重拍、不需要替换。** 展开态的四行（`Reading shikimate.csv:1-40` / `Searching for chorismate` / `Running python` / `Running shikimate-figures.ipynb`）在新 head 上逐字节等价于原渲染结果（文本与几何全同）。
- 一个前提要写清楚：**探针夹具的 toolCall 不带 `presentation.title`**，所以 v2 图展示的是「客户端兜底」路径；真实服务端如果给非 shell 工具附了 title，行文本会走 edge 第 1、3 行那种服务端措辞。这是本次修复的目的，不是回归。

## 本目录的图（仅作改动证据，不进 v2 对比）

| 文件 | 像素 | md5 |
| --- | --- | --- |
| `1440-edge-old.png` | 1044x476 | `b89f0a06ddad6a7973f01278bc1eefb2` |
| `1440-edge-new.png` | 1044x476 | `8edf80941e9eb368b00ee5a722e952ad` |
| `390-edge-old.png` | 572x524 | `0f755c36a9c4ef3a8d7be1bcd581598e` |
| `390-edge-new.png` | 572x524 | `002caf9675c5f06ad9e2dcfc7b22aeca` |

## 恢复

`/tmp/p2`、`/tmp/p3` 两个 detached worktree 用后即删；`wt/up-act` 保持 `chore/activity-stageshow` `ece86228`，`git status --porcelain` 为空；4177/4178 已停。
