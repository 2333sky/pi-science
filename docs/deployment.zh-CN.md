# 安装与本地生产部署

[English](deployment.md) · [README](../README.zh-CN.md)

源码安装流程会构建 contracts、Node 控制面、Agent Worker、SQLite 资源、内核桥接脚本和 React 前端。生产模式在 `http://127.0.0.1:8787` 同时提供浏览器页面和 API。需要包含 npm 的 Node.js >=24.16.0；npm 将 package.json 中 `packageManager` 声明的精确 pnpm 版本引导到缓存中。安装期间需要访问包注册表，启动期间不下载软件包。

| 操作 | macOS / Linux | 原生 Windows |
| --- | --- | --- |
| 安装并构建 | `bash scripts/install.sh` | `powershell -File scripts/install.ps1` |
| 环境诊断 | `bash scripts/pi-science.sh doctor` | `powershell -File scripts/pi-science.ps1 doctor` |
| 生产模式启动 | `bash scripts/start.sh` | `powershell -File scripts/start.ps1` |
| 开发模式启动 | `bash scripts/start.sh --dev` | `powershell -File scripts/start.ps1 -Dev` |
| 停止后台或已验证归属的服务 | `pi-science stop` | `pi-science stop` |

`pi-science` 安装到用户的可执行文件目录。Bash 还支持 `start --detach --no-open`，PowerShell 保持前台运行。两者均支持 `status`、`logs`、`install` 和 `doctor`。日志位于仓库内的 `.runtime/pi-science`，应用数据和工作区目录继续使用原有配置。

`doctor` 的必需检查失败时退出码为 1，参数无效时为 2。它不安装软件、不初始化持久数据库、不联系 LLM，也不测试网络下载是否可用。对于尚不存在的数据目录，它检查最近的现有父目录，不创建目录。科学计算环境和提供商配置作为按需设置单独说明。请在启动前运行诊断：即使端口由另一个 Pi-Science 实例占用，也会报告端口冲突。

## 故障恢复

- 缺少构建或依赖：重新运行对应平台安装器。修改源码后需要刷新生产构建；编辑源码时可使用 `start --dev`。
- 端口被占用：查看 `status`，停止已确认归属的应用，或修改 `PI_SCIENCE_CONTROL_PLANE_PORT`。停止命令不会仅凭端口号结束未知进程。
- Windows 状态文件缺失或过期：手动核对进程，不应根据监听端口猜测归属。缺少身份信息的旧状态文件不会被用于停止进程。
- 崩溃或 Windows 强制停止后，现有应用实例锁有 30 秒的恢复宽限期。`doctor` 会报告仍在运行或近期创建的实例锁，请等待宽限期结束后再启动。
- 启动错误：查看 `pi-science logs` 和 Windows 的 `*.log.err` 文件。启动失败时会清理已确认归属的进程；内部随机令牌生成失败时会拒绝启动。
- 数据迁移错误：保留原始数据，使用兼容的应用版本恢复完整备份。Git 源码降级不能代替数据回滚。

启动器绑定到回环地址。前端内部 HttpOnly Cookie 不构成独立的用户身份或授权体系；远程多人部署需要另行设计身份认证和授权边界。

## 验收与后续工作

`node --test scripts/doctor.test.mjs` 覆盖诊断失败场景。`bash scripts/test-launcher.sh` 覆盖源码模式的启动、停止和进程身份校验。`powershell -File scripts/test-process-identity.ps1` 覆盖身份缺失或过期、仓库/入口/令牌不匹配以及有效归属；其中的 CIM 模拟可跨平台运行。

`node scripts/smoke-production.mjs` 使用实际构建产物和对应平台启动器，检查 SQLite 就绪状态、HTML、JS 资源、SPA 路由回退、认证 API、状态记录和查询、停止清理，以及对外部监听进程的保护。CI 生产安装任务在 Linux、macOS 和 Windows 上运行实际安装器，不预先执行 pnpm 安装步骤。上述验收不需要 API Key 或 Python/R 环境。

后续工作包括版本化 Release、独立安装包、在停止应用后备份数据并支持恢复的事务式更新器，以及默认保留用户数据的卸载功能。当前改动尚未实现这些命令。备份必须包含应用状态和工作区内的元数据，详见[数据归属](architecture.zh-CN.md#持久化与数据归属)。
