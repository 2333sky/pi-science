# queue-ux 视觉验证（`queue-ux-redesign` @ `075bfcf8` vs `1d6fcdf7`）

| 项 | 值 |
|---|---|
| 改前 | `1d6fcdf719932cefa2943465555b2e95301750bb`（`67ad5ad9` 合 dev `433f1f51`） |
| 改后 | `075bfcf8eeb066a048804c3403e3043119ababb8` |
| 夹具 | 仓库 `frontend/tests/visual/fixtures/data.mjs`，`VISUAL_CWD=/tmp/visual-demo`，会话 `visual-session-1`（空闲）/ `visual-running`（`is_streaming: true`） |
| 固定时钟 | `FIXED_NOW=2026-08-15T12:00:00.000Z` |
| 渲染 | Chromium 1248 headless，DPR 2，en-US，Asia/Shanghai，`reducedMotion: reduce`，浅色，鼠标 (4,4) |
| 队列数据 | `/api/sessions/*/queue` 路由拦截喂固定 JSON（非真 server）：空闲 0 条、运行中 2 条、滚动态 4 条 |

## 1. 运行中（队列 2 条，面板展开）

| 视口 | 版本 | doc sw/cw | row sw/cw | row 高 | Stop left–right | 在视口 | 在卡片内 | elementFromPoint 命中 Stop |
|---|---|---|---|---|---|---|---|---|
| 360 | 改前 | 360/360 | 274/274 | 112 | 297–331 | True | True | True |
| 360 | 改后 | 360/360 | 274/274 | 118 | 297–331 | True | True | True |
| 390 | 改前 | 390/390 | 304/304 | 112 | 327–361 | True | True | True |
| 390 | 改后 | 390/390 | 304/304 | 118 | 327–361 | True | True | True |
| 430 | 改前 | 430/430 | 344/344 | 112 | 367–401 | True | True | True |
| 430 | 改后 | 430/430 | 344/344 | 78 | 367–401 | True | True | True |
| 768 | 改前 | 768/768 | 410/410 | 78 | 689–723 | True | True | True |
| 768 | 改后 | 768/768 | 410/410 | 78 | 689–723 | True | True | True |
| 1024 | 改前 | 1024/1024 | 666/666 | 42 | 945–979 | True | True | True |
| 1024 | 改后 | 1024/1024 | 666/666 | 42 | 945–979 | True | True | True |
| 1440 | 改前 | 1440/1440 | 747/747 | 42 | 1193.4–1227.4 | True | True | True |
| 1440 | 改后 | 1440/1440 | 747/747 | 42 | 1193.4–1227.4 | True | True | True |

Stop 位置改前改后**逐档相同**；行高 360/390 由 112 → 118、430 由 112 → 78，其余不变。

## 2. 空闲（无队列）

| 视口 | 版本 | row 高 | 重叠 | appr rect (l–r) | model rect (l–r) | appr 文字 可见/全文 | model 名 可见/全文 |
|---|---|---|---|---|---|---|---|
| 360 | 改前 | 120 | True | 81–164.7 | 89–292.5 | 不截断（换行） | 不截断 |
| 360 | 改后 | 42 | False | 104–153.4 | 198.4–291 | 不截断 | 不截断 |
| 390 | 改前 | 120 | True | 81–164.7 | 117.5–321 | 不截断（换行） | 不截断 |
| 390 | 改后 | 42 | False | 104–167 | 212–321 | 不截断 | 不截断 |
| 430 | 改前 | 120 | True | 81–164.7 | 157.5–361 | 不截断（换行） | 不截断 |
| 430 | 改后 | 42 | False | 105–185 | 230–361 | 不截断 | 不截断 |
| 768 | 改前 | 108 | False | 337–464.9 | 479.5–683 | 不截断（换行） | 不截断 |
| 768 | 改后 | 42 | False | 367–470.9 | 515.9–683 | 不截断 | 不截断 |
| 1024 | 改前 | 42 | False | 373–500.9 | 735.5–939 | 不截断（换行） | 不截断 |
| 1024 | 改后 | 42 | False | 373–500.9 | 735.5–939 | 不截断 | 不截断 |
| 1440 | 改前 | 42 | False | 540.6–668.5 | 983.9–1187.4 | 不截断（换行） | 不截断 |
| 1440 | 改后 | 42 | False | 540.6–668.5 | 983.9–1187.4 | 不截断 | 不截断 |

截断列来自单独一次 5 档探针（`/tmp/pr244-probe/queueux-clip.mjs`，只测改后），单位 px：可见 `clientWidth` / 全文 `scrollWidth`（approval 94、model 名 86）。

## 3. 队列面板

- **390 折叠态（改后）**：section h 16、「2 queued」、`aria-expanded`=false、列表在 DOM=False、items DOM=0、textarea 完整可见=True
- **390 展开 4 条（改后）**：section h 130.4、「4 queued」、`aria-expanded`=true、列表在 DOM=True、items DOM=4、ul h 110.4 / maxH 110.4px / scrollHeight 212 / clientHeight 110 / overflowY auto、textarea 完整可见=True
- 390 展开 2 条：ul h 104、maxH 110.4px、scrollHeight 104 = clientHeight → 不内滚；1440 展开 2 条：ul h 72（每条 36）、2 条时 ≤110.4 也不需要滚。
- 改前：390 面板 h 104、无折叠头（没有 `aria-expanded` 按钮）、`max-height: none`、永远全部展开。

## 4. 截图

| 文件 | 尺寸 |
|---|---|
| `1024-idle-after.png` | 2048×268（DPR 2，逻辑 1024×134） |
| `1024-idle-before.png` | 2048×268（DPR 2，逻辑 1024×134） |
| `1024-running-after.png` | 2048×468（DPR 2，逻辑 1024×234） |
| `1024-running-before.png` | 2048×428（DPR 2，逻辑 1024×214） |
| `1440-idle-after.png` | 2880×268（DPR 2，逻辑 1440×134） |
| `1440-idle-before.png` | 2880×268（DPR 2，逻辑 1440×134） |
| `1440-running-after.png` | 2880×468（DPR 2，逻辑 1440×234） |
| `1440-running-before.png` | 2880×428（DPR 2，逻辑 1440×214） |
| `360-idle-after.png` | 720×316（DPR 2，逻辑 360×158） |
| `360-idle-before.png` | 720×472（DPR 2，逻辑 360×236） |
| `360-running-after.png` | 720×744（DPR 2，逻辑 360×372） |
| `360-running-before.png` | 720×680（DPR 2，逻辑 360×340） |
| `390-collapsed-after.png` | 780×516（DPR 2，逻辑 390×258） |
| `390-idle-after.png` | 780×316（DPR 2，逻辑 390×158） |
| `390-idle-before.png` | 780×472（DPR 2，逻辑 390×236） |
| `390-running-after.png` | 780×732（DPR 2，逻辑 390×366） |
| `390-running-before.png` | 780×680（DPR 2，逻辑 390×340） |
| `390-scroll-after.png` | 780×744（DPR 2，逻辑 390×372） |
| `430-idle-after.png` | 860×268（DPR 2，逻辑 430×134） |
| `430-idle-before.png` | 860×424（DPR 2，逻辑 430×212） |
| `430-running-after.png` | 860×604（DPR 2，逻辑 430×302） |
| `430-running-before.png` | 860×632（DPR 2，逻辑 430×316） |
| `768-idle-after.png` | 1536×268（DPR 2，逻辑 768×134） |
| `768-idle-before.png` | 1536×400（DPR 2，逻辑 768×200） |
| `768-running-after.png` | 1536×572（DPR 2，逻辑 768×286） |
| `768-running-before.png` | 1536×532（DPR 2，逻辑 768×266） |

## 5. 未覆盖 / 风险

- 队列条目是路由拦截喂的 JSON，未在真 server 上验证「立即投递」「stop 后继续 drain」「durable message id」。
- 未覆盖深色主题、键盘焦点环、拖拽排序、面板折叠动画。
- 空闲窄屏（≤430）approval 文案被省略号截断到 15–46px（只剩「A.」「As.」），模型名在 360/390 完全不可见（只剩「Medium」）。
- `max-h-[6.9rem]`（110.4px）在手机上每条约 50px，只能看到约 2 条；「最多 3 行」只在桌面（每条 36px）成立。
