# Pi-Science

**Scientific AI Workbench · 科学 AI 工作台**

*A web-native workbench where scientists converse with AI agents to explore data, write analysis code, visualize results, and track every artifact's lineage — all in the browser.*

*一个基于 Web 的科学工作台。科学家通过与 AI 智能体对话来探索数据、编写分析代码、可视化结果，并追踪每件产物的完整谱系——一切都在浏览器中完成。*

---

## Features · 功能特色

### Agent Chat · 智能体对话

The core interface: a streaming chat where AI agents write, execute, and visualize scientific code in real time.

核心交互界面：与 AI 智能体实时对话，智能体即时编写、执行科学代码并生成可视化结果。

- **Streaming responses** — SSE-based real-time output, every tool call rendered as an expandable card
- **25+ LLM providers** — Anthropic, DeepSeek, OpenAI, and more, switchable in Settings
- **Tool visualization** — file writes, shell commands, and code execution expand inline with syntax-highlighted diffs
- **Markdown rendering** — agent responses support tables, code blocks, LaTeX math, and file-path detection
- **Session management** — create, resume, fork, and delete conversations; history preserved per workspace
- **AGENTS.md / KNOWLEDGE.md** — per-workspace agent instructions auto-seeded on session creation

### Scientific File Viewers · 科学文件查看器

15+ built-in viewers render scientific data formats natively in the browser. No plugin needed.

内置 15+ 种文件查看器，无需插件即可在浏览器中原生渲染科学数据格式。

| Category · 类别 | Formats · 格式 | Renderer |
|---|---|---|
| **Astronomy · 天文** | FITS | Canvas + color maps (magma, viridis, gray) |
| **Chemistry · 化学** | CIF, PDB, SDF, MOL, SMILES, XYZ | 3D WebGL (3Dmol.js) — rotate, zoom, measure |
| **3D / CAD** | STL, OBJ, PLY, glTF, GLB | WebGL (Three.js) — orbit, pan, wireframe |
| **Solid-state Physics · 固体物理** | EIGENVAL, DOSCAR | SVG band-structure & DOS charts |
| **Phase Diagrams · 相图** | JSON phase data | Convex-hull analysis with phase labels |
| **Genomics · 基因组** | BED, GFF, GTF, VCF | Canvas genome browser with annotation tracks |
| **Tabular Data · 表格数据** | CSV, TSV | Sortable HTML table + SVG charts (line, bar, scatter) |
| **Office Documents** | DOCX, XLSX, PPTX | Native JS renderers — no Office required |
| **Code · 代码** | Python, R, Bash, Markdown, JSON | Syntax highlighting (highlight.js) |
| **Images & Media** | PNG, JPEG, GIF, SVG, PDF, MP4 | Native `<img>`, `<iframe>`, `<video>` |

### File Browser · 文件浏览器

A persistent sidebar that mirrors the workspace directory — browse, preview, and manage files without leaving the conversation.

持久化侧边栏，镜像工作区目录——无需离开对话即可浏览、预览、管理文件。

- Click any file to preview in the right inspector panel
- Right-click context menu: copy name, copy path, delete
- Drag-and-drop file upload into workspace
- Breadcrumb navigation in the full Files page

### Inspector Panel · 检查器面板

The right-side panel that adapts to what you select — preview, provenance, or notebook.

右侧面板根据选择内容自适应切换——文件预览、版本谱系或交互式笔记本。

- **File Preview** — code, tables, molecules, FITS images, genome tracks, and more
- **Version History** — every write/edit recorded; expand any version to see who (which model), how (which tool), and the full code or diff
- **Notebook** — Python/R kernel with cell-based interface for interactive exploration

### Provenance Tracking · 谱系追踪

Every file the agent creates or edits is automatically recorded with full lineage. Click the history button (clock icon) in any file preview to see:

智能体创建或修改的每一个文件都会被自动记录完整谱系。点击文件预览中的历史按钮即可查看：

- **Tool & model** — which tool wrote it and which model was thinking
- **Code & diff** — the exact generating code or the edit diff
- **Environment snapshot** — Python version, platform, `pip freeze` lockfile (one-click to view)
- **Reproduce** — one-click draft a reproduce prompt to regenerate and compare
- **Conversation link** — jump to the originating session

### Computing · 计算

- **Python / R Kernels** — persistent, isolated sessions per notebook; execute code and capture output
- **Jupyter Lab** — one-click start/stop from the Notebooks page; opens in a new browser tab
- **Large File Probe** — structure detection for files too large to preview (CSV, NetCDF, FITS, Parquet, STL, genomics); shows schema, row counts, column types, sample values without loading the entire file
- **Experiment Runs** — track commands, outputs, and status in `.pi-science/runs.jsonl`

### Extensions · 扩展

| Extension · 扩展 | What it does · 功能 |
|---|---|
| **pi-mcp-adapter** | Bridge to MCP servers — literature search (PubMed, arXiv), biomed, materials databases, weather |
| **pi-subagents** | Multi-agent orchestration: scout, researcher, planner, worker, reviewer, oracle |
| **pi-web-access** | Web search, URL fetching, YouTube/video understanding |

### Workspaces · 工作区

- **Projects page** — card grid of workspaces, create new or open existing folders
- **Session isolation** — each workspace has its own `.pi-science/` directory with sessions, provenance, and runs
- **Per-workspace configuration** — different API keys, models, and MCP servers per project

### Theme & Internationalization · 主题与国际化

- **Warm paper aesthetic** — cream whites, soft shadows, serif headings; dark mode via `[data-theme="dark"]`
- **English & Simplified Chinese** — switch in Settings; all UI labels, file viewers, and inspector panels translated
- **Resizable panels** — drag to resize sidebar, inspector, and composer

---

## User Interface · 用户界面

### Pages · 页面

| Page · 页面 | Route · 路由 | What you do there |
|---|---|---|
| **Projects** | `/` | Workspace cards — create, open, or delete project folders |
| **Chat** | `/live/:sessionId` | Agent conversation — streaming responses, tool cards, file previews |
| **Files** | `/files` | Full file browser — breadcrumb nav, table/chart views for data files |
| **Notebooks** | `/notebooks` | .ipynb listing, Jupyter Lab start/stop, kernel status |
| **Runs** | `/runs` | Experiment history — command, status, host, outputs |
| **Skills** | `/skills` | Installed agent skills and scientific tool detection |
| **Settings** | `/settings` | LLM config, API keys, model selection, extensions, MCP servers |

### Layout · 布局

```
┌─ Header ──────────────────────────────────────────────────────┐
│  [Projects]  [Chat]  [Files]  [Notebooks]  [Runs]  [Skills]  [Settings]  │
├─ Sidebar ───┬─ Center (Chat / Content) ──┬─ Inspector ───────┤
│  File tree  │  Agent messages            │  File preview     │
│  (browse,   │  Tool cards                │  Version history  │
│   right-    │  Code blocks               │  Notebook cells   │
│   click)    │  Markdown                  │                   │
│             │  Composer input            │                   │
├─────────────┴────────────────────────────┴───────────────────┤
│  Status bar: pi processes · kernel sessions · health          │
└──────────────────────────────────────────────────────────────┘
```

---

## Quick Start · 快速开始

### Prerequisites · 前置条件

- **Python** ≥ 3.11 with `pip`
- **Node.js** ≥ 22
- **LLM API key** — e.g. `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENAI_API_KEY`

### One command · 一行命令

```bash
git clone <this-repo> && cd pi-science
bash scripts/dev.sh
```

This installs everything and starts both servers:
- **Frontend** → `http://127.0.0.1:5173`
- **Backend** → `http://127.0.0.1:8787`
- **API docs** → `http://127.0.0.1:8787/docs`

Then open Settings → LLM, enter your API key, and start a conversation.

### Configure API Key · 配置 API 密钥

Set via the Settings UI (`http://127.0.0.1:5173/settings` → LLM tab) or environment variable:

```bash
export DEEPSEEK_API_KEY=sk-...   # or ANTHROPIC_API_KEY, OPENAI_API_KEY
```

---

## Tech Stack · 技术栈

| Layer · 层级 | Technology |
|---|---|
| **Frontend** | React 19, TypeScript 6, Vite 8, Tailwind CSS 3, Zustand 5, React Router 7 |
| **Backend** | Python 3.11+, FastAPI, Uvicorn, Pydantic, sse-starlette |
| **Agent Runtime** | pi (Node.js, JSONL RPC over stdin/stdout) |
| **3D** | Three.js, 3Dmol.js |
| **Chemistry** | OpenChemLib |
| **Documents** | docx-preview, ExcelJS, pptx-preview |
| **Code** | highlight.js |
| **Fonts** | Inter, Source Serif 4, JetBrains Mono |

## License

MIT
