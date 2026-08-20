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
- **JSON-file storage** (not SQLite). All data in `data/*.json` per account (auto-created on first write).
- **`database.js`** exports `createDatabase(dataDir)` for isolated test/workspaces; the default export is the root `DATA_DIR` instance.
- Route modules under `lib/http/` (`mount.js` wires knowledge, workspace, backup, agent, computer).
- Route ordering is **critical**: `PUT /api/logs/reorder` and `PUT /api/todos/reorder` must be defined **before** their `/:id` routes.
- ID generation: simple `Math.max(...ids) + 1` — no auto-increment.
- **Error handling**: Route handlers use try/catch, returning `{ error: message }` JSON with appropriate HTTP status codes.
- **Image upload**: Multer `upload.single('image')` is called inline in the route handler (not as middleware).

### Knowledge model (notes-only in UI)

- All user-facing content is **knowledge notes** (`note:<id>`) or **imported files** (`file:<id>`) in `knowledge-documents.json`.
- Legacy `logs.json` entries are **auto-migrated** to native notes on first knowledge API access (`lib/knowledge/migrate-logs.js`); backup copy at `logs.migrated.json`, then `logs.json` is cleared.
- There is **no** `log:<id>` virtual adapter and **no** workbench UI for hours/pinned/CSV export.
- `/api/logs` remains as a **compatibility API** (tests, old scripts); new content should use `/api/knowledge/documents`.

### Data Files (auto-created in `{dataDir}/`)

| File | Purpose |
|------|---------|
| `logs.json` | Legacy work logs; emptied after migration (see `logs.migrated.json`) |
| `logs.migrated.json` | One-time backup of pre-migration logs |
| `.logs-migrated.json` | Migration marker (`log id → note id`) |
| `knowledge-documents.json` | Notes and imported file metadata |
| `knowledge-files/` | Imported attachment binaries |
| `todos.json` / `countdowns.json` | Todos and countdowns |
| `categories.json` | Knowledge base / folder tree |
| `agent-sessions.json` / `agent-runs.json` / `agent-memories.json` | Agent runtime |
| `ai-settings.json` | Encrypted model keys |
| `ai-chats.migrated.json` | 旧独立 AI 对话一次性备份（迁移后 `ai-chats.json` 为空） |
| `.ai-chats-migrated.json` | 旧对话 id → Agent session id 映射标记 |
| `uploads/` | Markdown inline images; served at `/uploads/` |
| `private-uploads.json` | Diary image protection markers |

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
- **Settings → Memory**: 11 tunables in `ai-settings.json` via `lib/agent/memory-settings.js` (refresh rounds/proposals/scan limits, title & content caps, context injection counts). Defaults match former hardcoded values; min ≥ 1, no upper cap. L0 rules stay fixed in `memory.js`.
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
- `lib/agent/` — runtime, routes, tools, `memory-settings.js` (Memory tunables merged into `DEFAULT_AI_SETTINGS` / `normalizeAiSettings`)
- `lib/workspace/` — ZIP export/restore
- `lib/http/backup-routes.js` — JSON backup/restore HTTP handlers
- `gen_images.py` — standalone script, unrelated to the web app
