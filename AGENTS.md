# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

- **Install**: `npm install` (first-time setup)
- **Build vendor assets**: `npm run build` (copies marked / DOMPurify / KaTeX / pdf.js into `public/vendor/`; required before running `node server.js` directly)
- **Start server**: `npm start` (builds vendor assets, then starts Express)
- **Tests**: `npm test` (builds vendor assets, then runs Node tests)
- **Port**: Set `PORT` env var (default 3000). E.g. `PORT=3001 npm start`
- Vanilla JS frontend served as static files. No CodeMirror/Monaco bundle.

## Architecture

### Backend (`server.js` + `database.js`)
- Express serves `public/` statically and provides a REST API.
- **JSON-file storage** (not SQLite — `better-sqlite3` native build failed on Windows). All data in `data/*.json` (auto-created on first write via `ensureDataDir()`).
- Route ordering is **critical**: `PUT /api/logs/reorder` and `PUT /api/todos/reorder` must be defined **before** their `/:id` routes, otherwise Express matches `"reorder"` as an `:id` parameter.
- ID generation: simple `Math.max(...ids) + 1` — no auto-increment.
- **Error handling convention**: All route handlers use try/catch, returning `{ error: message }` JSON with appropriate HTTP status codes.
- **CSV export**: Prepends UTF-8 BOM (`﻿`) for Excel compatibility.
- **Image upload**: Multer `upload.single('image')` is called inline in the route handler (not as middleware), so Multer errors are surfaced in the callback rather than going to Express error handling.

### Data Files (auto-created in `data/`)
| File | Schema |
|------|--------|
| `logs.json` | `id, title, content, category, hours, log_date, sort_order, created_at, updated_at` |
| `todos.json` | `id, title, done, sort_order, due_date, priority, created_at` |
| `categories.json` | Array of strings, defaults: `['会议','开发','文档','测试','学习','其他']` |
| `uploads/` | Markdown inline images from notes/logs; served at `/uploads/` |
| `knowledge-documents.json` | Native notes and imported file metadata |
| `knowledge-files/` | Imported attachment binaries (docx/pdf/images); served via `/api/knowledge/files/:id/content` |

Default categories are hardcoded in `database.js` and used when `categories.json` doesn't exist yet. When a category is deleted, logs using it are reassigned to `"其他"`.

### Frontend (`public/`)
- **Workbench SPA**: `index.html` + `css/workbench.css` + `js/workbench.js`. Modes: Agent / 知识库 / Memory. Knowledge has a browse/todos sub-view (`data-knowledge-view`).
- **Login**: `login.html` + `js/login.js`. Account profile, password, and admin user management live in Settings → 账户 (`js/accounts.js`).
- **Todos**: `js/todos.js`, shown inside knowledge as `#knowledge?view=todos`.
- **State**: Workbench keeps a module-local `state` object — no framework, no global `app.js`.
- **Knowledge editor**: Title/body/date fields in workbench; logs remain sourced from `logs.json`. Markdown preview uses vendor `marked` + DOMPurify. Notes/logs insert inline images via `#insertImageButton` → `POST /api/upload` → `![alt](/uploads/...)`.
- **Imported files**: Knowledge import stores binaries in `knowledge-files/` with metadata in `knowledge-documents.json`; photo wall removed.
- **Diary**: Unlock via `#diaryDialog` and the shared magic phrase; locked diary stays out of knowledge lists and Agent context.

### Key Patterns
- `$` = `document.querySelector` (defined in each module that needs it, or imported from `helpers.js`)
- `escHtml(str)` for HTML escaping, `debounce(fn, ms)` for search input
- Knowledge auto-save is debounced in `workbench.js`; Ctrl+S flushes pending document/annotation saves
- Route hash: `#agent`, `#knowledge`, `#memory`; todos use `#knowledge?view=todos`

### API Endpoints
```
GET    /api/logs?date=&month=&category=&search=&page=&limit=20
POST   /api/logs                       body: {title,content,category,hours,log_date}
PUT    /api/logs/:id
DELETE /api/logs/:id
PUT    /api/logs/reorder               body: {orderedIds: [id,…]}
GET    /api/logs/:id
GET    /api/stats
GET    /api/export                     ?month=&category=&search=  (CSV download)
POST   /api/upload                     multipart: {image: <file>}
DELETE /api/uploads/:filename
GET    /api/todos
POST   /api/todos                      body: {title,due_date?,priority?}
PUT    /api/todos/:id                  body: {title?,done?,due_date?,priority?}
DELETE /api/todos/:id
PUT    /api/todos/reorder              body: {orderedIds: [id,…]}
GET    /api/categories
POST   /api/categories                 body: {name}
PUT    /api/categories/:oldName        body: {name: newName}
DELETE /api/categories/:name
```

### Notable Files
- `gen_images.py` — standalone image generation script, unrelated to the web application.
