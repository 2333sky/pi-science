# PR #247 活动面板：改前 / 改后视觉证据（`pi-science#pr247-visual-2`）

改前 `433f1f51cb72`（dev 合并基线）｜改后 `ec69c81d0e56d074801b3c7b95c691955ca2e9ec`（PR head）

两张图同夹具、同冻结时钟、同 DPR、同 locale/timezone/主题。

## 夹具与参数

- 夹具：`frontend/tests/visual/fixtures/data.mjs`（会话 `visual-session-1`），`VISUAL_CWD=/tmp/visual-demo`
- 冻结时钟：`FIXED_NOW=2026-08-15T12:00:00.000Z`（`page.clock.setFixedTime`），页面渲染时间也固定
- DPR 2，浅色，locale `en-US`，timezone `Asia/Shanghai`，`reducedMotion: reduce`，Chromium 1248 headless
- 鼠标停在 `(4,4)`，截图前不 hover 任何行（hover 态单独一张，见下）
- 数据为探针 server 注入的活动历史（与视觉夹具同格式，不是真 server 跑出来的任务）：
  - 已完成 1m05s：read `data/shikimate.csv`（1–40）→ search `chorismate` → bash `python analysis/aggregate.py --condition SAH` → notebook `notebooks/shikimate-figures.ipynb` → 回答
  - 运行中：read `data/shikimate.csv`（1-20）已完成 + bash `pip install --quiet pandas matplotlib seaborn statsmodels` 进行中
- 截图按元素矩形在 DPR 2 下裁剪，故像素宽 = CSS 宽 × 2

## 文件清单

| 文件 | 像素 | md5 |
| --- | --- | --- |
| `before/1440-settled.png` | 1538x130 | `dbd71d2d28a085b3040d9526ccc317f0` |
| `after/1440-settled.png` | 1538x130 | `dbbe254ca13036da3508001132635605` |
| `before/390-settled.png` | 588x138 | `af6d7d4a5b7e33582b37198005393cb2` |
| `after/390-settled.png` | 588x138 | `cd3e0db27bb9bf4f6d24162725455409` |
| `before/360-settled.png` | 528x138 | `14026bb0b922b17ecc49e19bc044d1d5` |
| `after/360-settled.png` | 528x138 | `7ad9681cc5f716d88287f16cfde96a15` |
| `before/1440-expanded.png` | 1538x442 | `f731b3fb9c9e47ab31189fa2c5c553ed` |
| `after/1440-expanded.png` | 1538x446 | `68f33ab7c74dc4dac9808ec781817476` |
| `before/390-expanded.png` | 588x482 | `a9c625babd2e1c050e2f97131abe7b67` |
| `after/390-expanded.png` | 588x486 | `709307cb6f8f8da321903e44cfc27916` |
| `before/360-expanded.png` | 528x482 | `95656ad4233adf5249bdf24892d80469` |
| `after/360-expanded.png` | 528x486 | `7f9008c027f6b47220987df26c08a4c0` |
| `before/1440-running.png` | 1538x188 | `444eae021966da121c66df4ba033ff57` |
| `after/1440-running.png` | 1538x204 | `c91396a73fbf52e015da08e79e1ab0e7` |
| `before/390-running.png` | 588x204 | `2cd04d118b9255e86cab43260f9bd5ec` |
| `after/390-running.png` | 588x220 | `36f5642385f4423ff69df3d9046c2e35` |
| `before/360-running.png` | 528x204 | `8921c2785d6741b007e2f5909f73d0bf` |
| `after/360-running.png` | 528x220 | `64e59fc130f21d79ec53fa207c3d30fd` |
| `before/1440-notebook.png` | 1498x80 | `f22d4e1f4b756be8bda4f4454a35bfc3` |
| `after/1440-notebook.png` | 1498x88 | `8c3a7568e8abff29e543d65a4d1aa589` |
| `before/1440-hover.png` | 1538x442 | `1417515c5c102521fca9a7971c8a37c8` |
| `after/1440-hover.png` | 1538x446 | `cdeac07c0b2696215e8871992717985d` |

细节数值（行高/行宽/行左缘/图标/面板高/溢出）见 `measurements.json` 的 `shots` 表。

## 逐状态：改了什么

### 1. 收起摘要行（`*-settled`，1440 / 390 / 360）— **几乎无变化**

- 摘要文本、字号、行高、宽度、内边距全部相同：`Completed · 1m05s`，高 36（1440）/ 40（390、360），面板 45 / 49。
- 唯一差异：右侧展开箭头 **13px → 12px**（`lucide-chevron-down`）。1440 两张整图只有 87 个像素不同，bbox `(1498,47)-(1508,63)`。
- 结论：收起态视觉等价，不构成采纳理由，也不构成风险。

### 2. 展开后的步骤列表（`*-expanded`，1440 / 390 / 360）— **一眼可见**

| # | 元素 | 改前 | 改后 |
| --- | --- | --- | --- |
| 1 | 分组标题 | 有 `Explored · 2 operations`（x491.6） | 无，扁平列表 |
| 2 | 行首图标 | 每行都是 `✓ check` | 分类图标：`file-text` / `search` / `terminal` / `sigma` |
| 3 | read 标题 | `Reading shikimate.csv` | `Reading shikimate.csv:1-40`（带切片） |
| 4 | run 标题 | 整条命令行 `python analysis/aggregate.py --condition SAH` | `Running python` |
| 5 | 行高（`≥640` / `<640`） | 32 / 36，`min-h-8`、`padding 4px 0` | 36 / 40，`min-h-control`、`padding 8px 0` |
| 6 | 行宽（可点区） | 满宽 748.8 / 274 | 内容宽 245.8 / 230.6 / 165.9 / 323.8（390 下 notebook 行仍 274） |
| 7 | 行左缘 | x491.6 / x84 | 不变（x491.6 / x84） |
| 8 | 行尾箭头 | 只在 hover 时出现（桌面与触屏都不常显） | 桌面静止时隐藏，hover 才显示；<640 触屏档（`@media (hover: none)`）**常显** |
| 9 | trace / 面板高 | 156 / 201（1440）；172 / 221（390） | 158 / 203；174 / 223 |

- 两版行内标题都是 13px / 18px，文字左缘一致；变化的是图标字形与行的可点宽度。
- 行宽从「整列」变成「内容宽」是**交互面积变化**：1440 下最宽行 748.8 → 323.8，点击目标相应缩小，但点哪里都仍落在同一按钮内。

### 3. 运行中（`*-running`，1440 / 390 / 360）— **一眼可见**

- 进行中的 bash：整条命令行 `pip install --quiet pandas matplotlib seaborn statsmodels`（蓝色，无时长）→ `Running pip`（蓝色 + 脉动点）。
- read：`Reading shikimate.csv` → `Reading shikimate.csv:1-20`。
- 行高 36 → 40（<640），32 → 36（1440）；面板 74 → 82（1440）、82 → 90（390/360）。

### 4. Notebook / kernel 命名（`*-notebook`，1440 全宽带）

- 两版文本**完全相同**：`Running shikimate-figures.ipynb`。
- 差异只有图标 `✓ check` → `Σ sigma`，以及 `Python` chip 与耗时从行尾右对齐变为紧随标题的内联排列。
- 说明：dev 基线 `433f1f51` 的 presenter 已经对 `notebook_run` 取路径命名，所以「kernel 命名」这条相对本 PR 的基线**没有净收益**；它是相对分支起点 `ece86228` 的修复。

### 5. Hover（`1440-hover`）

- 两版行为**相同**：hover 时行文字 `rgb(97,102,107)` → `rgb(15,17,21)`，行尾箭头 `opacity 0` → `1`。
- 两版都**没有背景色带**（`background-color` 始终 `rgba(0,0,0,0)`）。也就是说「hover 带」在本对比里不存在，不构成改后的新增项。

## 一眼可见的两对差异

1. `1440-expanded` 一对：分组标题消失 + 四类分类图标 + `Running python` / `Reading …:1-40`。
2. `1440-running` 一对：整条 pip 命令行 → `Running pip`，面板高 74 → 82。

## 无变化 / 等价证据

- 收起摘要两版布局数值逐项相同（高 36/40、宽一致、文本一致），仅有箭头 13→12 的 87 像素差。
- 所有 22 张图的所有状态：`documentElement.scrollWidth == clientWidth`、trace `scrollWidth == clientWidth`，无横向滚动。

## 未覆盖

- **深色主题**：只拍了浅色。
- **键盘焦点与展开后的输出面板**（点开某一行看工具输出）：未覆盖。
- **真实 server**：活动历史是探针注入的固定数据，不是真跑 agent 产生的；格式与仓库视觉夹具一致。
- **hover 的触屏表现**：只验了桌面 hover；`@media (hover: none)` 下箭头常显这一点未单独截图。
- **空/错误活动**（无步骤、工具失败）未覆盖。

## 精确数值补充

- 摘要行：箭头 `13×13` → `12×12`，行盒两版都是 `36`（1440）/ `40`（390、360），`font-size 15px / line-height 22.5px` 两版相同。
- 步骤行：标题两版都是 `13px / 18px`；`padding` 由 `4px 0` 变为 `8px 0`，`min-height` 由 `32px`（`min-h-8`）变为 `36px`（`min-h-control`），<640 由 `36px`（`min-h-9`）变为 `40px`（`min-h-primary`）。
- 行宽按内容收缩后，最长一行（notebook）748.8 → 323.8（1440）、274 → 274（390，触屏下满宽）。
