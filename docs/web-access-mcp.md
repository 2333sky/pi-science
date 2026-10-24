# 内置联网搜索与网页抓取

`web_search`、`web_fetch` 直接注册为 Agent Harness 工具，复用固定版本 `pi-web-access@0.40.0` 的 host-neutral core。开发模式由 TS loader 加载，服务端构建时用 esbuild 打包核心；生产模式无需 TS loader。没有本地 Web Access MCP 服务、MCP 握手或连接器发现。

| 工具 | 参数与用途 |
| --- | --- |
| `web_search` | `query`；可选 `numResults`、`recencyFilter`、`domainFilter`。返回来源链接、摘要和 responseId。 |
| `web_fetch` | `url` 抓取网页/PDF；或 `responseId` 配合 `offset`、`limit` 分页读取已有搜索/抓取结果。可选 `queryIndex`、`urlIndex` 选择缓存条目，默认 0。URL 模式可选 `readable`、`raw`。 |

不再暴露 `mcp__web-access__*`、`fetch_content`、`get_search_content` 或 `source_check`。返回文本中的缓存翻页提示统一使用 `web_fetch`。Paper Search 等科学数据库连接器继续在 MCP 设置中管理。

## 设置与凭据

**设置 → 联网搜索**是全局配置，包括：

- 联网搜索开关；网页及 PDF 阅读开关。
- 搜索服务：自动、Exa、Brave、Tavily、Perplexity、Jina、DeepSeek。
- 各服务 API Key 的保存、替换和删除。留空保存其他设置会保留已有 Key；切换服务会清空尚未保存的输入。

GET/PUT `/api/settings/web-access` 提供配置接口。GET 只返回 Key 是否配置，不返回密钥或凭据引用。PUT 支持部分更新，空 Key 表示解除绑定。API Key 存入既有 CredentialStore；普通 `config.json` 的 `web_access` 只保存工具开关、服务选择与 `credential_refs`。

保存后通过既有 runtime reload 机制使空闲 Worker 重新加载，忙碌 Worker 在当前操作结束后重新加载。每次调用仍读取最新工具开关，因此已注册工具也不能在关闭后继续发起新调用。新 Worker 隐藏禁用工具；已有会话恢复时自动补充可用的新内置工具。

自动模式由上游核心选择可用服务；有些服务需要 Key，Exa 也支持公共搜索服务免 Key 路径，实际可用性取决于网络与上游服务。为确定使用某个服务，请显式选择它。

### DeepSeek

在搜索服务中显式选择 **DeepSeek** 并填写 API Key。两个工具使用同一份独立配置的 Key：

- `web_search` 调用 `POST https://api.deepseek.com/v1/tools/search`，映射 `query`、`numResults → count`，固定 `need_content=false`，输出链接和长摘要。
- `web_fetch(url=...)` 调用 `POST https://api.deepseek.com/v1/tools/fetch`，返回 Markdown；选择该服务时 `raw` 参数也不会改为下载原始 HTML。缓存分页在本地 Worker 完成，不会重复请求服务。

站点过滤映射为 `site:` / `-site:` / `OR`，时间过滤映射为 `after:`。组合后的查询必须为 1～128 个 Unicode 字符；超过限制会提示缩短，不静默截断。请求固定使用官方地址和 Bearer 鉴权，禁止自动重定向；限制响应体为 5 MiB，并传递取消信号、设置 30 秒超时。HTTP 鉴权、余额、限速等错误会明确返回，不自动换用其他服务。

DeepSeek 缓存单独保留最近 50 个结果；切换服务后，在同一个 Worker 中仍能通过旧 responseId 读取。自动模式沿用原有服务选择；添加 DeepSeek Key 不会自动切换服务。DeepSeek Fetch 的内容类型支持以官方服务响应为准，失败时不静默改成本地抓取。

接口依据：[Search 文档](https://api-docs.deepseek.com/zh-cn/api/search/)、[Fetch 文档](https://api-docs.deepseek.com/zh-cn/api/fetch/)、[使用指南](https://api-docs.deepseek.com/zh-cn/guides/search/)。

## 执行边界

工具在可信 Worker 中执行 HTTP，不经过 Bash/Python 的 OS sandbox、MCP 连接器审批或 MCP 网络 allowlist。保留上游公共地址检查、逐跳重定向验证、响应体大小限制、取消信号与超时处理。URL 输入限制为不带凭据的 HTTP(S)，不接受本地文件路径。网页内容始终是不可信外部材料。

内置配置固定关闭 GitHub Clone / PR Issue 处理，固定 `ssrf.allowRanges=[]`、`ssrf.trustEnvProxy=false`。不开放浏览器 Cookie、代理或 SSRF 例外等工具参数。精确能力列表继续约束委派；confined/candidate 执行不获得这两个联网工具。

核心在首次调用时才初始化。配置生成在 `<PI_SCIENCE_HOME>/web/runtime/web-search.json`，以 0600 权限保存必要运行凭据，不读取其他 Pi Agent 的 HOME/XDG 配置。不要手工编辑生成文件。缓存为 Worker 内存中的有界缓存，最多保存 50 个结果，重启或设置重载后失效；失效后重新搜索/抓取。

## 旧版本迁移

启动时退役 `mcp_builtin_web_access` 并更新工作区 MCP 投影。如果还没有新的 `web_access` 设置，会迁移旧连接器的全局启停、工具过滤与全局 deny，以及 Brave 凭据引用；已有新配置优先。旧的项目级 MCP 授权不再属于内置联网工具的设置域。

旧操作者文件 `<PI_SCIENCE_HOME>/mcp/web-access/config.json` 仍可提供兼容选项。支持的服务选择与 Key 会显示到新设置页；首次保存时把 Key 迁入凭据存储。新的服务设置覆盖兼容值；固定安全约束始终优先。旧文件的其他高级服务仅作为兼容选项，不在当前选择界面中提供。

## 验证

```sh
pnpm --filter @pi-science/server exec vitest run src/web/deepseek.test.ts src/web/tools.test.ts src/http/routes/settings-web-access.test.ts src/http/routes/mcp-routes.test.ts
pnpm --filter frontend exec vitest run src/components/settings/WebSearchTab.test.tsx src/components/settings/SettingsContent.test.tsx
pnpm --filter @pi-science/server build
node apps/server/scripts/smoke-web-access.mjs
# 可选：访问公共服务进行实测
node apps/server/scripts/smoke-web-access.mjs --live
```

测试覆盖原生搜索、抓取、缓存翻页、私网与重定向阻断、响应大小、取消、已有工具撤销、设置部分更新、凭据脱敏及迁移。
