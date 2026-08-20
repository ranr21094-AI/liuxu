# Work Log

本地优先、支持多账户隔离的 Agent 工作台。工作日志作为知识库文档，另有待办、倒数日和可选的 DeepSeek、Kimi、OpenRouter、Tavily、Perplexity、Seedream、WeStock 能力。数据保存在 JSON 文件中。

更新记录见 [ChangeLog.md](ChangeLog.md)。

## Quick Start

```bash
npm install
copy .env.example .env
npm start
```

macOS 或 Linux 可用 `cp .env.example .env`。首次启动前必须在 `.env` 中设置一个临时管理员密码：

```dotenv
AUTH_TOKEN=replace-with-a-temporary-password
```

首次启动会创建用户名为 `admin` 的管理员。打开 `http://localhost:3000/login`，使用 `admin` 和上述临时密码登录，然后按提示改成 10–128 个字符的新密码。

`AUTH_TOKEN` 只用于第一次创建管理员；`data/users.json` 创建后，旧 Bearer Token 会失效，修改 `AUTH_TOKEN` 也不会覆盖登录密码。完成首次改密后可以从 `.env` 删除它。

常用命令：

```bash
npm run build
npm test
```

`npm start` 和 `npm test` 会自动把 marked、DOMPurify、KaTeX、pdf.js 拷到 `public/vendor/`；如果直接运行 `node server.js`，请先执行 `npm run build`。

默认仅监听 `127.0.0.1:3000`。若已有 `users.json`，后续启动不再需要 `AUTH_TOKEN`；若既没有用户注册表又没有 `AUTH_TOKEN`，服务会拒绝启动并给出初始化提示。

待办提醒测试命令：

```bash
npm run todo:reminder:test -- --to your@email.com --all-open
```

只预览正文、不真正发送：

```bash
npm run todo:reminder:test -- --to your@email.com --all-open --dry-run
```

## Recent Updates

- 默认首页为 Agent 工作台：顶栏切换 **Agent / 知识库 / Memory / 待办** 四个模式；桌面端固定侧栏，窄屏为抽屉。
- 知识库侧栏为两级导航（知识库列表 → 文件夹与文档）；支持 MiniSearch 检索、Markdown/KaTeX 预览、文件导入（MD/TXT/PDF/DOCX/图片）、归档与恢复。
- Agent 会话侧栏显示日期与消息数；支持搜索、重命名、归档，归档会话在设置 → 会话中恢复或删除。
- 独立 AI 对话页、日志内 AI、照片墙、`/legacy.html` 和 CodeMirror 日志编辑器已移除；模型与联网配置统一在设置中，供 Agent 使用。
- 完整变更见 [ChangeLog.md](ChangeLog.md)。

## 工作台概览

| 模式 | Hash | 侧栏 | 主区域 |
| --- | --- | --- | --- |
| Agent | `#agent` / `#agent/:sessionId` | 会话列表（按时间分组） | 对话、工具审批、记忆建议 |
| 知识库 | `#knowledge` / `#knowledge?base=…` / `#knowledge/:documentId` | 知识库 → 文件夹 → 文档 | 笔记/日志编辑或导入文件预览 |
| Memory | `#memory` | L2 事实 / L3 流程 | 长期记忆与待确认提案 |
| 待办 | `#todos` | 分类筛选、邮件提醒 | 待办与倒数日 |

旧链接 `#knowledge?view=todos` 会自动重定向到 `#todos`。

顶栏还提供「私密知识」锁定状态、运行状态、设置（模型/联网/生图/电脑工具/归档会话/账户）和账户菜单。

## Main Areas

### 账户与登录

- 未登录访问 `/` 或 `/index.html` 会跳转到 `/login`；API 返回 401 时前端统一回到登录页。
- 用户名为 3–32 位字母、数字、点、下划线或短横线；登录密码使用 Node `crypto.scrypt` 和随机盐保存。
- 会话 Cookie 为 HttpOnly、SameSite=Strict，有效期 24 小时；磁盘中只保存令牌哈希、账户 ID 和过期时间。
- 新账户和管理员重置密码后的账户必须首次改密；修改或重置密码、停用账户都会撤销相关会话。
- 管理员可管理账户元数据，但没有成员工作区、备份、数据量或内容的读取入口。
- 普通成员可在设置 → 账户中修改显示名称和登录密码；管理员用户管理也在该面板。

### Agent

- 左侧按「今天 / 最近 7 天 / 更早」分组展示会话；每行显示标题，副行显示**最后更新时间 · 消息数**（不再显示最后一条消息预览）。
- 支持新建会话、搜索（仍匹配标题与消息正文）、重命名、归档。
- 对话区用 `@知识库` 或 `@日期` 注入本地材料；写入类工具、联网搜索、生图、代码运行等需先确认。
- 长期记忆以提案形式出现，确认后才写入 L2/L3；Memory 模式可浏览、归档或刷新提案。
- 模型、联网、Seedream 生图、电脑工具策略在设置中配置；Agent 侧栏底部可快速打开模型设置。

### 知识库与日志

- 根级侧栏只列知识库；进入某个知识库后显示面包屑、文件夹树、搜索/筛选和文档列表。
- 原一级分类对应知识库，子分类对应文件夹；工作日志仍以 `logs.json` 为源，编辑器可改标题、正文和日期。
- 笔记与日志支持 Markdown 编辑/预览（含 GFM 表格、任务列表、KaTeX 公式）；预览区图片可双击放大。
- 导入文件只读预览正文；可为导入文件写关联笔记。文档与文件夹支持软归档与恢复。
- 搜索支持智能/严格预设与字段筛选；`GET /api/knowledge/tree` 返回树结构与文档数量。
- 工时、置顶、按日浏览日志等字段与 `GET/POST/PUT /api/logs` 仍保留，工作台界面不再提供日历、归档卡片或 CSV 导出。

### Memory

- 浏览已确认的 L2（事实）与 L3（流程）记忆；可归档不再需要的条目。
- 「刷新记忆」会基于近期会话生成提案，需在对话或 Memory 模式中确认后才会写入。

### 待办

- 独立顶栏模式 `#todos`；主区域在「待办 / 倒数日」之间切换。
- 侧栏显示分类筛选和邮件提醒设置；支持拖拽排序、优先级、重复规则、备注与清除已完成。
- 倒数日按香港业务日期计算剩余或已过天数。
- 每日邮件提醒汇总所有分类中当天到期且未完成的待办；详见下文「待办邮件提醒配置」。

### 分类

- 知识树可新建、重命名和归档知识库/文件夹。
- `categories.json` 中的「日历显示」仍影响日志按日筛选 API，工作台无日历界面。

### 文件存储

- **笔记/日志内嵌图片**：`POST /api/upload` → `{dataDir}/uploads/`，Markdown 引用 `/uploads/{filename}`；编辑区工具栏「插入图片」并支持粘贴。
- **知识库导入附件**：二进制在 `{dataDir}/knowledge-files/`，元数据在 `knowledge-documents.json`，下载走 `/api/knowledge/files/:id/content`。
- **Agent 生图**：确认后保存到 `uploads/` 并在对话中返回本地链接。

## AI 与模型

AI 设置保存在当前账户的 `ai-settings.json`（Key 经 AES-256-GCM 加密），供 **Agent** 使用；不再提供独立 AI 对话页或日志内 AI 面板。

- **设置 → 模型**：DeepSeek、Moonshot/Kimi、OpenRouter Key、默认模型、最大循环轮数、思考模式等。
- **设置 → 联网**：Tavily、Perplexity；Agent 通过 `web.search` 等工具在确认后调用。
- **设置 → 生图**：Seedream Key 与默认参数；Agent 通过 `image.generate` 在确认后生图。
- **设置 → 技能**：WeStock 等工具策略（具体以 Agent 工具注册为准）。
- OpenRouter 模型目录通过 `GET /api/ai/models` 拉取；旧管理员工作区仍可使用 `.env` 中的服务端回退 Key。

Agent 本地检索不会索引未解锁的私密知识；日记内容需解锁后才进入 `@` 引用与知识搜索。

## Configuration

复制 `.env.example` 后可按需配置：

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP 服务端口 | `3000` |
| `HOST` | 监听地址；对外监听时必须启用账户认证 | `127.0.0.1` |
| `DATA_DIR` | 用户注册表、账户数据和上传目录 | `./data` |
| `AUTH_TOKEN` | 仅在没有 `users.json` 时初始化 `admin` 的一次性密码 | required on first start |
| `DEEPSEEK_API_KEY` | 旧管理员工作区可使用的服务端 DeepSeek 回退 Key | empty |
| `DEEPSEEK_BASE_URL` | DeepSeek API 基础地址 | `https://api.deepseek.com` |
| `DEEPSEEK_DEFAULT_MODEL` | 默认 DeepSeek 模型 | `deepseek-v4-flash` |
| `MOONSHOT_API_KEY` | 旧管理员工作区可使用的服务端 Moonshot 回退 Key | empty |
| `MOONSHOT_BASE_URL` | Moonshot API 基础地址 | `https://api.moonshot.cn/v1` |
| `OPENROUTER_API_KEY` | 旧管理员工作区可使用的服务端 OpenRouter 回退 Key | empty |
| `AI_SECRETS_KEY_FILE` | 账户 AI Key 的 AES-256-GCM 主密钥文件路径 | platform default |
| `TAVILY_API_KEY` | 旧管理员工作区可使用的服务端 Tavily 回退 Key | empty |
| `TAVILY_BASE_URL` | Tavily API 基础地址 | `https://api.tavily.com` |
| `PERPLEXITY_API_KEY` | 旧管理员工作区可使用的服务端 Perplexity 回退 Key | empty |
| `PERPLEXITY_BASE_URL` | Perplexity API 基础地址 | `https://api.perplexity.ai` |
| `SEEDREAM_API_KEY` | 旧管理员工作区可使用的服务端 Seedream 回退 Key | empty |
| `SEEDREAM_BASE_URL` | Seedream API 基础地址 | `https://ark.cn-beijing.volces.com/api/v3` |
| `SEEDREAM_DEFAULT_MODEL` | 默认 Seedream 模型 | `doubao-seedream-5-0-260128` |
| `WESTOCK_NPX_COMMAND` | WeStock CLI 启动命令 | `npx -y westock-data-clawhub@1.0.4` |
| `QQ_EMAIL_ACCOUNT` | QQ 发信邮箱账号 | empty |
| `QQ_EMAIL_AUTH_CODE` | QQ 邮箱 SMTP 授权码 | empty |

### 待办邮件提醒配置

1. 在 QQ 邮箱中开启 SMTP，并获取授权码。
2. 在 `.env` 中填写 `QQ_EMAIL_ACCOUNT` 与 `QQ_EMAIL_AUTH_CODE`。
3. 重启服务，在待办侧栏「邮件提醒」中设置启用状态、收件邮箱和发送时间（默认 `08:00`）。
4. 服务每 60 秒检查一次；只提醒当天到期且未完成的待办；SMTP 失败会重试同一份当天快照。

### 首次迁移说明

- 若 `DATA_DIR` 中还没有 `users.json`，启动时必须提供 `AUTH_TOKEN`。
- 服务会先检查现有 JSON 数据，再原子创建 `admin`；现有日志、待办、分类、上传文件不会移动。
- 创建用户注册表后，`AUTH_TOKEN` 不再覆盖账户配置，可从 `.env` 删除。
- `users.json` 或 `auth-sessions.json` 损坏时，服务会保留 `.corrupt-*.bak` 副本并拒绝登录。

## 私密知识（日记）

- 标记为 `visibility: diary` 的知识（含「日记」分类下的日志）在**未解锁**时不出现在知识列表、搜索和 Agent `@` 上下文中。
- 顶栏 **私密知识** 按钮打开口令对话框；输入固定暗语「如意如意」（与 `server.js` 中 `DIARY_MAGIC_PHRASE` 一致）解锁，再次点击可锁定。
- 解锁状态通过 `diary_session` Cookie 维持（24 小时，按账户隔离）。备份/恢复与 ZIP 导出需先解锁。

## Data And Privacy

默认数据目录为 `data/`；首次管理员使用根目录，新账户位于 `accounts/<storage_key>/`。

| File | Content |
| --- | --- |
| `users.json` | 账户、scrypt 密码哈希、存储目录键 |
| `auth-sessions.json` | 会话令牌哈希与过期时间 |
| `logs.json` | 工作日志（知识库 `log:<id>` 数据源） |
| `todos.json` / `countdowns.json` | 待办与倒数日 |
| `todo-categories.json` / `todo-reminder-*.json` | 待办分类与邮件提醒 |
| `categories.json` | 知识库/文件夹树与日历显示设置 |
| `knowledge-documents.json` / `knowledge-files/` | 笔记与导入文件 |
| `agent-sessions.json` / `agent-runs.json` / `agent-memories.json` | Agent 会话、运行与长期记忆 |
| `ai-settings.json` | 加密后的模型与工具 Key |
| `uploads/` | Markdown 内嵌图与 Agent 生图 |
| `private-uploads.json` | 私密图片保护标记 |

隐私要点：所有工作区 API 从 Cookie 会话解析账户；管理员不能读取成员工作区；账户 AI Key 加密存储，主密钥需单独备份迁移；`.env` 与 `data/` 已在 `.gitignore` 中。

## Backup And Restore

- **JSON 备份**（`GET /api/backup`）：结构数据（日志、待办、分类等），标记 `format: structure`，不含二进制；旧版 `aiChats` 字段仅用于恢复兼容。
- **ZIP 工作区**（`GET /api/workspace/export`）：含知识附件、上传、Agent 数据等完整副本；恢复用 `POST /api/workspace/restore`（支持 JSON 或 ZIP，`?mode=merge` 可合并）。
- 不含 `users.json` 或其它账户凭据；私密知识需解锁后才能备份/恢复。

## Chrome 扩展与 Windows 原生执行

- 仓库 `chrome-extension/` 为 Manifest V3 扩展，仅与 localhost 应用页通信，通过配对码绑定标签页。
- Windows 电脑工具默认关闭；管理员在本机环回访问中重新验证密码并配置目录白名单后，Agent 才可执行文件读写与 `code.run`（非沙箱，等同当前用户权限）。

## Mobile Access

将 `HOST` 设为 `0.0.0.0`，手机与电脑在同一局域网访问 `http://<电脑 IP>:<PORT>`。对外网请使用 HTTPS 反向代理或隧道，不要直接暴露 HTTP。

## Development Notes

- 后端：Express + JSON 文件存储（`database.js` 工厂按账户目录实例化）。
- 前端：原生 JS（`index.html` + `workbench.js` + `workbench.css`），无 React/CodeMirror  bundle。
- 构建：`npm run build` 复制 vendor 到 `public/vendor/`。
- 路由顺序：`PUT /api/logs/reorder`、`PUT /api/todos/reorder` 等须定义在对应 `/:id` 之前。

## Relevant API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 登录 |
| `GET` | `/api/auth/check` | 登录状态 |
| `POST` | `/api/auth/logout` | 退出 |
| `GET/PATCH` | `/api/auth/me` | 当前账户 / 改显示名 |
| `PUT` | `/api/auth/password` | 改登录密码 |
| `POST` | `/api/auth/diary` | 用暗语解锁私密知识 |
| `POST` | `/api/auth/diary/lock` | 锁定 |
| `GET` | `/api/auth/diary/status` | 锁定状态 |
| `GET/POST/PATCH` | `/api/admin/users` … | 管理员账户管理 |
| `GET/POST/PUT/DELETE` | `/api/logs` … | 日志 CRUD（兼容层） |
| `GET/POST/PUT/DELETE` | `/api/todos` … | 待办 |
| `GET/POST/PUT/DELETE` | `/api/countdowns` … | 倒数日 |
| `GET/PUT` | `/api/todo-reminder-settings` | 邮件提醒 |
| `GET/POST/PUT/DELETE` | `/api/categories` … | 分类树 |
| `POST` | `/api/upload` | 上传内嵌图片 |
| `GET/POST` | `/api/backup` / `/api/restore` | JSON 备份恢复 |
| `GET/PUT` | `/api/ai/settings` | Agent 模型设置 |
| `GET` | `/api/ai/models` | 模型目录 |
| `GET` | `/api/knowledge/tree` | 知识库树 |
| `GET/POST/PATCH/DELETE` | `/api/knowledge/documents` … | 知识文档 |
| `POST` | `/api/knowledge/documents/:id/archive` | 归档 |
| `POST` | `/api/knowledge/documents/:id/restore` | 恢复 |
| `POST` | `/api/knowledge/imports` | 导入文件 |
| `GET` | `/api/knowledge/search` | 本地检索 |
| `GET` | `/api/knowledge/files/:id/content` | 原文件 |
| `GET/POST/PATCH/DELETE` | `/api/agent/sessions` … | Agent 会话 |
| `POST` | `/api/agent/sessions/:id/messages` | 发起运行 |
| `GET` | `/api/agent/runs/:id/events` | SSE 事件 |
| `POST` | `/api/agent/runs/:id/approvals/:id` | 审批工具 |
| `GET/DELETE` | `/api/agent/memories` … | 长期记忆 |
| `POST` | `/api/agent/memory/refresh` | 生成记忆提案 |
| `GET/PUT` | `/api/admin/agent-policy` | 电脑工具策略 |
| `GET` | `/api/workspace/export` | ZIP 导出 |
| `POST` | `/api/workspace/restore` | ZIP/JSON 恢复 |

除登录相关接口外，均需有效 `site_session` Cookie；`/api/admin/*` 需管理员角色。
