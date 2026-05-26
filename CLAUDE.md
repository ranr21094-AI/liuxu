# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Install**: `npm install` (first-time setup)
- **Start server**: `npm start` (or `node server.js`)
- **Port**: Set `PORT` env var (default 3000). E.g. `PORT=3001 npm start`
- No build step, test runner, or linter. Vanilla JS frontend served as static files.

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
| `uploads/` | Uploaded images, served at `/uploads/` via `express.static` |

Default categories are hardcoded in `database.js` and used when `categories.json` doesn't exist yet. When a category is deleted, logs using it are reassigned to `"其他"`.

### Frontend (`public/`)
- **Single-page app**: `index.html` (structure) + `style.css` (styles) + `app.js` (logic)
- **Two main views**: list view (`.list-view`) and full-screen editor view (`.editor-view`), toggled via `display`. Routes are client-side only (no router).
- **State management**: Single global `state` object — no framework.
- **Calendar**: Rendered in JS, year/month dropdown selects + prev/next month buttons. Highlights dates with logs, click to filter.
- **Log list**: Cards showing title, category, markdown-rendered content, hours. Drag-and-drop reordering via HTML5 DnD API. Pagination at the bottom.
- **Editor**: Write/preview tabs — preview renders markdown via `marked.parse()` with `breaks: true, gfm: true`. Auto-save with 1.5s debounce on any input change. Ctrl+S to save manually.
- **Category management modal**: Modal overlay with list of categories. Each has inline rename (click ✎, edit, press Enter) and delete (with confirmation). Default categories (会议/开发/文档/测试/学习/其他) are marked and cannot be deleted. Custom categories typed in the editor's custom field are auto-added to the managed list on save.
- **Todo panel**: Sidebar list with add/ toggle/ delete. Drag-and-drop reorder. "Clear completed" button.
- **Stats panel**: Week/month hours, daily average, total logs, category breakdown chips with color dots.
- **Image upload**: Button in editor tabs bar opens file picker. Uploads via `POST /api/upload` (multipart, field: `image`). Inserts `![](url)` markdown at cursor position. Supports PNG, JPG, GIF, WebP, BMP, SVG (max 10MB). Stored in `data/uploads/` with timestamp+random filename.
- **Markdown rendering**: Uses `marked` loaded from CDN (`marked/marked.min.js`) — not an npm dependency. Both the log list cards and the editor preview call `marked.parse()` with `breaks: true, gfm: true`.

### Key Patterns
- `$` = `document.querySelector`, `$$` = `document.querySelectorAll` (defined at the end of `app.js`, used sparingly — mainly in drag-and-drop cleanup and tab switching)
- `escHtml(str)` for HTML escaping, `debounce(fn, ms)` for search input
- `stripMarkdown(md)` — used for plain-text extraction from markdown content
- `refreshAll()` — calls `loadLogs()`, `loadStats()`, `loadTodos()`, `loadCategories()` in parallel on init
- Categories flow: Editor's custom category field + dropdown → on save, custom values auto-POST to `/api/categories` if new
- **Auto-save**: 1.5s debounce on any input change (title, content, date, hours, category, custom category). Also triggers on navigating back from editor. Ctrl+S saves immediately (bypasses debounce).

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
