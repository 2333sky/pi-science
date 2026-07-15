---
title: 项目知识 Reviewer 验收记录
date: 2026-07-15
status: passed
---

# 项目知识 Reviewer 验收记录

## 自动化结果

| 验证项 | 命令 | 结果 |
|---|---|---|
| 后端单元/API 测试 | `backend/.venv/bin/python -m pytest -q --ignore=tests/test_integration.py` | 101 passed |
| 前端单元测试 | `cd frontend && npm test` | 5 passed |
| 前端生产打包 | `cd frontend && npx vite build` | passed |
| 本次前端文件 lint | `npx oxlint ...KnowledgePage.tsx ...project-knowledge.ts` | passed, 0 warnings |
| Chrome 端到端验收 | `cd frontend && npm run test:uat:knowledge` | passed |

仓库的 `npm run build` 会先执行全仓库 `tsc -b`。当前仍会报告本功能之前已经存在的 Inspector 类型不一致、Three.js 类型声明和未使用变量等历史问题；本次功能通过 Vite 生产打包、针对性 lint、前端测试和 Chrome 运行态验收。

## Chrome 端到端覆盖

自动 UAT 脚本使用临时工作区，不读取或修改用户的 `.data/` 与 `workspaces/`：

1. 初始化项目骨架和 `PROJECT.md`；
2. 打开 Project Knowledge 页面；
3. 确认内部 Markdown 管理标记不会显示；
4. 查看知识建议和文件整理建议；
5. 对文件建议运行路径、碰撞和引用安全预览；
6. 接受知识建议并确认内容写入 `PROJECT.md`；
7. 接受文件移动建议并确认文件真实移动；
8. 从历史记录撤销文件操作并确认文件恢复；
9. 切换暗色模式；
10. 在 375×812 视口验证无页面级横向溢出。

验收截图输出到系统临时目录：

- `pi-science-knowledge-uat-desktop.png`
- `pi-science-knowledge-uat-mobile.png`

## 真实模型集成验证

使用当前 Custom API 默认模型和临时 Pi session 执行 Reviewer：

- 输入：一条明确的项目知识审批决策和一条混合文件分类决策；
- Reviewer 结果：生成 2 条 `decision` 类型候选；
- 来源：两条建议均引用真实的 `real-message-1`；
- 安全边界：运行后 `pending_count=2`、`knowledge_count=0`；
- `PROJECT.md` 在用户批准前未发生知识写入。

## 手动验收步骤

1. 运行 `bash scripts/dev.sh`。
2. 新建或打开一个 Workspace。
3. 点击侧栏的 **Project Knowledge**，确认出现 `PROJECT.md` 概览。
4. 在对话中形成一个明确结论或决策，等待自动 Reviewer，或者点击输入框中的 **Review**。
5. 回到 **Project Knowledge → Inbox**，查看建议的类型、置信度、理由和来源。
6. 点击 **Edit** 修改内容，再点击 **Accept**。
7. 打开工作区根目录的 `PROJECT.md`，确认只出现已接受内容。
8. 准备一个测试文件，对文件整理建议点击 **Safety preview**。
9. 接受建议，确认文件移动；打开 **History** 点击 **Undo**，确认恢复。
10. 在 **Files → Policy** 中锁定一个目录，确认 Reviewer 文件建议不能修改该目录。
11. 拒绝一条建议，确认它不会进入 `PROJECT.md`，并在历史中留下审批记录。

## 通过标准

- Reviewer 永远只生成候选建议；
- 未批准内容不会进入正式知识或移动真实文件；
- 知识来源可以追溯到会话消息或项目文件；
- 文件操作不能越出工作区、触碰 `.pi-science`、覆盖目标或绕过锁定目录；
- 文件事务失败能够回滚，成功操作能够撤销；
- `PROJECT.md` 和结构化知识版本保持一致并可恢复；
- 页面在亮色、暗色、桌面和窄屏下均可完成核心审批流程。
