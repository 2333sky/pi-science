# 状态、传输与应用组装复核

本次复核确认了报告中的具体代码路径。项目仍适合模块化单体：科研工作台的状态权威、进程隔离和权限边界，比拆分部署单元更需要优先维护。

| 项目 | 核实结果 | 本次处理 |
| --- | --- | --- |
| 1. SSE 背压 | 存在。队列清空会覆盖 `push(false)` 的阻塞状态；Execution 直接写 socket | 会话和 Execution 共用 `BoundedSseStream`。仅 `_read()` 解锁，应用队列与 Readable 缓冲共用 512 KiB 字节预算，溢出断开并释放订阅。响应在回放前开始发送，回放按字节批次让出事件循环；补慢消费者、恢复顺序和 2 MiB 回放测试 |
| 2. Job / Execution 状态 | 已收敛。旧实现依赖异步写入和定时补偿 | SQLite 在创建 Job 时同事务写入 Execution，后续 Job 更新由数据库触发器原子投影；关闭重开测试验证终态一致。JSONL 仅作为无 SQLite 时的兼容后端 |
| 3. 权限回调接线 | 存在。`sessionServer` 丢失两个回调 | 合并为一个 `SessionServerOptions` 对象；生产组装要求资源探测、撤销和退出回调；真实模块组装测试验证内核撤销 |
| 4. HTTP 契约 | 存在。`limit=abc` 可进入服务，存储异常被转成 400 | Job body/query/params、Prompt 和审批响应使用共享运行时 schema；Job 错误统一为 `{ error: { code, message, fields? }, request_id }`。输入/冲突/能力不足/内部错误分别映射。全局 4xx 保留错误消息，前端支持新错误结构 |
| 5. Execution 历史成本 | 已收敛。旧实现写入后可能重新扫描全部 JSONL | 当前 Execution 记录迁入 SQLite 并使用工作区、创建时间索引查询；旧 JSONL 在启动迁移时归并导入，未启用 SQLite 时继续使用兼容实现 |
| 6. 路由业务编排 | 存在。Prompt 和审批流程均绑定 HTTP | 提取 `PromptSubmissionService`、`ApprovalInteractionService`；锁、持久化、投递不确定状态与审批完成流程进入用例。生产应用统一组装用例及 Job/Kernel/HTTP 使用的 Execution repository |
| 7. 幂等与异步语义 | 存在。Job 重试会重复执行，Prompt 允许无 ID | Job 支持 body `idempotency_key` 和 `Idempotency-Key` header，工作区隔离，持久状态保存内容摘要；并发和重启后重试返回相同任务，内容冲突为 409。Job 返回 202 + Location；创建会话返回 201 + Location；新增 `POST /jobs/:id/cancel` 和要求 ID 的 `POST /sessions/:id/prompts`，前端改用后者 |
| 8. 生命周期 | 存在。重复启动/停止和全局 URL 初始化清单 | 单一启动/关闭钩子；必需状态 worker 启动失败阻止启动，遗留导入或 MCP 初始化失败使 readiness 为 503 且不启动后台生产者。先停止后台生产者、会话、任务及内核，最后关闭存储；个别关闭失败仍继续释放其他资源。环境准备进入 Kernel/Notebook 对应用例 |

## 保留的契约与边界

- 会话 SSE 是带 cursor 的恢复流；Execution SSE 是刷新通知流。Execution 消费者在重连时重新查询 REST，不承诺通知重放。
- `POST /sessions/:id/prompt` 保留无 ID 的兼容行为，并通过 Deprecation / Link 标注新入口；`DELETE /jobs/:id` 保留取消行为。新入口和兼容入口共享幂等记录。
- Job 幂等请求以调用者提供的请求体为内容边界，字段顺序不影响摘要；相同键和不同请求体返回 409。无幂等键仍是兼容提交，每次创建任务。幂等保证依赖任务历史保留；不会自动重跑已失败任务。
- Job 是其 Execution 状态的权威来源。SQLite 触发器在同一事务内更新对应记录，避免出现“Job 已终态、Execution 仍运行”的可观察窗口。
- Agent 事件观察器使用应用拥有的 Execution repository；未启用 SQLite 的运行方式仍通过 JSONL 和跨进程锁保持兼容。

## 尚未实施的大范围迁移

以下建议仍成立，不能把本次修补视为已完成这些迁移：

1. Execution 查询改为游标分页。目前 SQLite 已提供索引过滤，但 HTTP 契约仍使用 `limit + offset`；超大历史集合仍可进一步改为稳定游标。
2. 是否保留完整 Execution 事件流水。SQLite 当前保存供产品查询的最新记录，旧 JSONL 导入时归并为最终记录；如果审计要求需要逐次状态变更，应新增独立事件表，而不是重新引入双写。
3. 所有历史 HTTP 路由统一切换结构化错误，以及从 schema 生成全量 OpenAPI。目前新 Job 接口采用新错误契约，其他路由保留现有兼容结构；共享 schema 和客户端错误读取已经准备好。
4. 远程计算等剩余独立进程入口的 Execution repository / 事件通知总线依赖注入。应用内 Agent 已接入统一 repository；进程外写入仍需明确 IPC 或单写者边界。
