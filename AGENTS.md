# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

- **Install**: `npm install` (first-time setup)
- **Build vendor assets**: `npm run build` (copies marked / DOMPurify / KaTeX / pdf.js into `public/vendor/`; required before running `node server.js` directly)
- **Start server**: `npm start` (builds vendor assets, then starts Express)
- **Tests**: `npm test` (builds vendor assets, then runs Node tests)
- **Port**: Set `PORT` env var (default 3000). E.g. `PORT=3001 npm start`
- Vanilla JS frontend served as static ES modules under `public/js/`. No CodeMirror/Monaco bundle.

## Architecture

### Backend (`server.js` + `database.js` + `lib/`)

- Express serves `public/` statically and provides a REST API.
- **SQLite storage** via `better-sqlite3`: per-account `{dataDir}/schedule.db`, global auth `{DATA_DIR}/users.db`. Binary assets remain on disk (`uploads/`, `knowledge-files/`, `agent-assets/`).
- **`lib/db/`**: connection pool, schema migrations, one-time JSON import (`import-json.js`, marker `.sqlite-migrated.json`, backups `*.pre-sqlite-bak`).
- **`database.js`** exports `createDatabase(dataDir)` for isolated test/workspaces; the default export is the root `DATA_DIR` instance. `backup()` / `restore()` still expose legacy JSON-shaped objects for compatibility.
- Route modules under `lib/http/` (`mount.js` wires knowledge, workspace, backup, agent, computer).
- Route ordering is **critical**: `PUT /api/logs/reorder` and `PUT /api/todos/reorder` must be defined **before** their `/:id` routes.
- ID generation: simple `Math.max(...ids) + 1` — no auto-increment.
- **Error handling**: Route handlers use try/catch, returning `{ error: message }` JSON with appropriate HTTP status codes.
- **Image upload**: Multer `upload.single('image')` is called inline in the route handler (not as middleware).

### Knowledge model (notes-only in UI)

- All user-facing content is **knowledge notes** (`note:<id>`) or **imported files** (`file:<id>`) in the `knowledge_documents` SQLite table.
- Legacy `logs.json` entries are **auto-migrated** to native notes on first knowledge API access (`lib/knowledge/migrate-logs.js`); backup copy at `logs.migrated.json`, then legacy logs are cleared from SQLite.
- There is **no** `log:<id>` virtual adapter and **no** workbench UI for hours/pinned/CSV export.
- `/api/logs` remains as a **compatibility API** (tests, old scripts); new content should use `/api/knowledge/documents`.

### Data Files (auto-created in `{dataDir}/`)

| File / DB | Purpose |
|------|---------|
| `schedule.db` | Per-account SQLite database (todos, logs, knowledge, agent, settings, …) |
| `users.db` | Global auth users + sessions (replaces `users.json` / `auth-sessions.json`) |
| `.sqlite-migrated.json` | One-time JSON→SQLite migration marker |
| `*.pre-sqlite-bak` | JSON backups taken during migration |
| `logs.migrated.json` | One-time backup of pre-migration logs |
| `.logs-migrated.json` | Migration marker (`log id → note id`) |
| `knowledge-files/` | Imported attachment binaries |
| `uploads/` | Markdown inline images; served at `/uploads/` |
| `agent-assets/` | Agent-generated binaries |

Removed: `photo-wall.json`, `/api/photo-wall*`, `/api/export` (CSV), standalone AI chat pages.

Default categories are hardcoded in `database.js`. When a category is deleted, documents in that path are reassigned to `"其他"` via `rewriteCollectionPath`.

### Frontend (`public/`)

- **Workbench SPA**: `index.html` + `css/workbench.css` + `js/workbench.js` (+ `workbench-backup.js`, `todos.js`, `accounts.js`, …).
- **Modes** (top bar): Agent / 知识库 / Memory / **待办** — hash routes `#agent`, `#knowledge`, `#memory`, `#todos` (`#knowledge?view=todos` redirects to `#todos`).
- **Login**: `login.html` + `js/login.js`. Account settings in Settings → 账户.
- **Todos**: `js/todos.js`, dedicated `#todos` mode (not a knowledge sub-view).
- **State**: Module-local `state` in `workbench.js` — no framework.
- **Knowledge editor**: Title/body/date; Markdown preview (`marked` + DOMPurify + KaTeX). Inline images via `#insertImageButton` → `POST /api/upload`.
- **Settings → 数据**: JSON/ZIP backup and restore (`workbench-backup.js`).
- **Settings → Memory**: tunables in the `ai_settings` SQLite row via `lib/agent/memory-settings.js` (refresh rounds/proposals/scan limits, title & content caps). L2/L3 不再全量注入 Agent；仅 L0 规则在 system prompt。Agent 通过 `memory.list` / `memory.search` / `memory.read` 按需读取（`memoryContextMaxL2/L3` 保留兼容但不再控制注入）。
- **Settings → 模型**: provider cards only (built-in providers removed from the UI; legacy keys auto-migrated once at startup by `lib/agent/migrate-builtin-providers.js`, marker `.builtin-providers-migrated.json`). Each card holds baseUrl / apiFormat / apiKey / models (fetch via `POST /api/ai/custom-providers/models`, cap 200) plus capability flags `supportsMedia` / `thinking` (''/deepseek/k3/optional/fixed) / `zdr`; provider count is uncapped. `resolveAiModelProfile` maps these onto the profile so thinking params / ZDR work identically for migrated providers.
- **Settings → 模型 → 高级 Agent 限制**: `lib/agent/agent-settings.js` — `agentDelegateMaxRounds`（子 run 独立轮数/tool 预算，与父 run 脱钩），护栏（连续失败、只读并发、重复写检测），`web.fetch` 上限，以及 `knowledge.search` / `knowledge.list` / `memory.list` / `memory.search` 条数限制。`web.search` 同 session 24h 内相同 query 会缓存（最多 32 条），同 run 内重复请求直接返回缓存并跳过审批。Merged into `DEFAULT_AI_SETTINGS` / `normalizeAiSettings`.
- **Diary**: Unlock via `#diaryDialog` and magic phrase; locked diary excluded from lists/search/Agent `@`.

### Key Patterns

- `$` = `document.querySelector` (local in modules or from `helpers.js`)
- `escHtml(str)`, `debounce(fn, ms)`, `showToast(message, type)`
- Knowledge auto-save debounced in `workbench.js`; Ctrl+S flushes pending saves
- Frontend uses ES modules (`import`/`export`); root `package.json` has no `"type": "module"` (Node tests import browser modules via dynamic `import()` — may log MODULE_TYPELESS warnings)

### API Endpoints (summary)

See `README.md` § Relevant API for the full table. Notable groups:

- **Auth**: `/api/auth/*`, `/api/admin/users`
- **Logs (compat)**: `/api/logs`, `/api/stats` — no CSV export
- **Knowledge**: `/api/knowledge/tree`, `/api/knowledge/documents`, `/api/knowledge/search`, `/api/knowledge/imports`, archive/restore
- **Agent**: `/api/agent/sessions`, `/api/agent/runs`, `/api/agent/memories`, `/api/ai/settings`
- **Backup**: `GET /api/backup`, `POST /api/restore`, `GET /api/workspace/export`, `POST /api/workspace/restore`
- **Todos / countdowns / categories**: `/api/todos`, `/api/countdowns`, `/api/categories`, …

### Notable Files

- `lib/knowledge/` — documents, search, migrate-logs, routes
- `lib/agent/` — runtime, routes, tools, `memory-settings.js` and `agent-settings.js` (tunables merged into `DEFAULT_AI_SETTINGS` / `normalizeAiSettings`); Agent tools include `knowledge.search` / `knowledge.tree` / `knowledge.list` (MiniSearch/list, same as UI), `memory.list` / `memory.read` / `memory.search` (L2/L3 on-demand; only L0 rules auto-injected), `agent.delegate` (one-level sub-run; approval / ask_user / browser / memory.propose bubble to parent), `web.fetch`, `code.run` (PowerShell/Python shell runner), `bash.run` (arbitrary Git Bash commands with cwd confined to allowlisted dirs — not a sandbox, same user privileges; requires confirmation), `ask_user`, `update_working_checkpoint`. 需用户确认的工具在一轮内进入 `queuedApprovals` 队列，仅逐条暴露给前端嵌入 `#agentComposer` 顶部的交互区（`#agentApprovalDock`，textarea 上方），并显示进度；长参数在 UI 中摘要展示，内容区限高可滚动，操作按钮固定可见。`ask_user` 的问题同样显示在该 dock，用户在下方输入框直接回复。
- `lib/workspace/` — ZIP export/restore
- `lib/http/backup-routes.js` — JSON backup/restore HTTP handlers
- `gen_images.py` — standalone script, unrelated to the web app
