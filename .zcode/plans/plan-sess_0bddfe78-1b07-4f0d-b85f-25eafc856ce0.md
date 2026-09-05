# 知识库每条笔记/文件的 AI 助手侧栏

目标：在知识库每条笔记/导入文件中加入独立的 AI 助手侧栏——与 Agent 一致的可调用工具的对话式 AI，能读取本篇内容、检索其他知识、并**提案修改**；提案以卡片预览，用户手动应用到编辑器（走现有防抖保存），服务端不直接写文档。

## 1. 数据层：会话与文档绑定（schema v4）

- 新迁移 `lib/db/migrations/004_note_assistant.sql`：`agent_sessions` 加 `document_id TEXT`（可空，普通 Agent 会话为 NULL）+ `idx_agent_sessions_document` 索引；`connection.js` `SCHEMA_VERSION` 升 4，迁移幂等。
- `lib/agent/store.js`：`createSession(title, { documentId })` 写入绑定；新增 `findLatestSessionForDocument(documentId)`（非归档）。

## 2. 后端：note_assist 运行类型与两个新工具

**新工具**（`lib/agent/tools.js` 注册 + `lib/agent/adapters.js` 实现，均为自动执行、无需审批，只读原文档）：
- `note.read`：读取绑定文档（标题/元数据/正文全文，超长按 mentions 的 `DOC_CHAR_LIMIT` 语义截断）。运行时每次调用实时读取最新已保存内容——用户边改边问自然生效。
- `note.propose_edit`：参数 `{ find, replace }`（find 需在当前正文中恰好匹配一次）或 `{ append: true, content }`（文末追加）。适配器在校验匹配后计算提案全文，写入 run 事件 `note.edit_proposed`（含 proposalId/documentId/find/replace/proposedContent/summary），工具结果返回"提案已交付用户预览"。**不落库**——应用与否完全由前端决定。

**`lib/agent/runtime.js`**：新增 `kind: 'note_assist'`：
- `toolsForRun`：仅放行 `note.read`、`note.propose_edit`、`knowledge.search`、`knowledge.read`、`knowledge.list`（无写入/委派/记忆/web 工具）。
- `startNoteAssist({ documentId, userMessage })`：复用/新建该文档绑定的会话，走既有 `driveRun` 循环、SSE 事件、200-run 清理；跳过记忆注入（note_assist 不注入 memory context）。
- 复用 diaryUnlocked 快照机制（锁定日记文档本就打不开编辑器，天然一致）。

**`server.js`**：`createAgentModelClient(req, { systemAddition })` 支持追加笔记助手系统指令（绑定文档说明、提案格式要求、问答风格）；`lib/agent/routes.js` 新增：
- `GET /api/agent/note-assist/:documentId/session` — 取该文档最近会话（消息+状态），无则 404。
- `POST /api/agent/note-assist/:documentId/messages` — `{content}` 创建/复用会话并启动 note_assist run（202 `{runId}`）；沿用现有 `GET /api/agent/runs/:id/events` SSE 与 `/cancel`；文档不存在/日记锁定返回 404/403。

## 3. 前端：`public/js/knowledge/note-assistant.js`（新模块，仿 links-history 范式）

- **入口**：编辑器工具栏加 AI 图标按钮（笔记与未归档文件都显示，与 `#insertImageButton` 同构注册）；点击在编辑器右侧滑出 ~360px 助手面板（窄屏 ≤1100px 变为覆盖抽屉）。
- **对话**：消息列表 + 输入框 + 发送/停止；订阅既有 run SSE（assistant 文本、knowledge.search 工具摘要折叠显示、note.edit_proposal 渲染为提案卡）；运行中显示状态；打开笔记时拉取历史会话渲染（纯文本消息），提供"新对话"。
- **提案卡**：显示 find 上下文（截断）→ replace 内容（高亮）或追加内容，按钮「应用」「忽略」。应用时在**编辑器当前值**上重新定位 find（用户可能已改动）：匹配唯一 → 替换并置光标；失配 → 提示"笔记已修改，无法定位原文"提供"复制内容"兜底。应用走 `insertTextAtCursor` 同款的 dirty + 800ms 防抖保存管线，预览自动刷新；忽略则卡片置灰。
- **生命周期**：`setActiveDocument(doc)`（加载/重置会话订阅）、文档切换前取消进行中 run 订阅、`clear()` 清理；AI 未配置时输入区提示并禁用。
- **workbench.js/index.html/workbench.css**：工具栏按钮 + 面板骨架挂载（documentWorkspace 内 flex 新增 aside），面板、消息气泡、提案卡、状态行样式（含暗色主题与 ≤1100px 抽屉化）。

## 4. 测试

- `lib/agent` 单测：note.propose_edit 的 find 唯一性校验/append/失配报错；note_assist 工具集过滤；store 的 document 绑定与查询；schema v4 迁移幂等。
- 路由测试：POST messages 创建绑定会话并启动 run（mock modelClient）、锁定日记 403、未知文档 404。
- 全量 `npm test` 通过；浏览器冒烟：打开笔记 → AI 侧栏问答 → 提案卡预览 → 应用后编辑器内容更新且自动保存 → 切换文档会话隔离 → 暗色主题与窄屏抽屉。

## 5. 文档

- ChangeLog.md 新增条目（未发布）；README 功能列表补一句；AGENTS.md 的 lib/agent 工具清单补 `note.read`/`note.propose_edit`。

**涉及文件**：`lib/db/migrations/004_note_assistant.sql`(新)、`lib/db/connection.js`、`lib/agent/store.js`、`lib/agent/tools.js`、`lib/agent/adapters.js`、`lib/agent/runtime.js`、`lib/agent/routes.js`、`server.js`、`public/js/knowledge/note-assistant.js`(新)、`public/js/workbench.js`、`public/index.html`、`public/css/workbench.css`、`test/`（新增 1-2 个用例文件）、`ChangeLog.md`、`README.md`、`AGENTS.md`。