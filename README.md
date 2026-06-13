# Work Log

本地优先的工作日志、待办和 AI 辅助应用。它用 JSON 文件保存数据，提供 Markdown/LaTeX 日志编辑、分类管理、日历浏览、待办主界面、统计、图片上传、模板、备份恢复，以及可选的 DeepSeek、Tavily、Perplexity、Seedream 和 WeStock 能力。

## Quick Start

```bash
npm install
copy .env.example .env
npm start
```

macOS 或 Linux 可用 `cp .env.example .env`。不创建 `.env` 也能运行，默认访问地址是 `http://localhost:3000`。

常用命令：

```bash
npm run build
npm test
```

`npm start` 和 `npm test` 会自动构建编辑器资源；如果直接运行 `node server.js`，请先执行 `npm run build`。

## Main Areas

### 日志

- 横向卡片列表：支持搜索、日期、月份、父分类和子分类筛选。
- Markdown 编辑器：桌面与手机统一使用 CodeMirror，支持语法高亮、查找、撤销、自动换行、自动保存。
- 预览模式：支持编辑、预览、分屏，以及 Markdown/LaTeX 渲染。
- 标题大纲：编辑页可展开当前 Markdown 的 `#` 至 `######` 标题树，并快速跳转。
- 全屏编辑：保留核心写作和预览控件，隐藏元信息和管理操作。
- 图片：支持上传或直接粘贴 PNG、JPG、GIF、WebP、BMP 图片，并插入 Markdown 图片链接。
- 模板：支持中文日期、日期偏移、周区间等占位符。

### 待办

- 侧边栏下拉选择 `待办面板` 后，右侧主体会切换到完整待办工作区。
- 主界面包含待办、今日、逾期、已完成统计。
- 支持待办/全部/已完成筛选，以及按标题和备注搜索。
- 任务可设置标题、截止日期、优先级和备注。
- 支持勾选完成、点击编辑、删除、清除已完成和拖拽排序。
- 侧边栏待办模式只保留轻量概览和快速新增，避免和主界面重复。

### 分类

- 分类管理通过侧边栏标题下拉进入。
- 支持父分类、子分类、拖拽排序、重命名和删除。
- 子分类支持在父分类详情中拖拽排序；日志筛选二级分类会沿用该顺序。
- 父分类和子分类显示日志数量。
- 父分类详情支持“列表 / 图谱”切换；图谱展示当前父分类和子分类关系，并可点击子分类进入浏览。
- 可为父分类设置“日历显示”，控制点击日历某天时该分类日志是否参与显示。
- 月份筛选、分类筛选和工时统计不会因“日历显示”关闭而丢失日志。

### 默认侧栏、日历与统计

- 默认侧栏显示可收起日历和当前日志导航，待办与统计默认隐藏在对应侧栏模式中。
- 日历收起后只显示日期和星期几，并会一起收起日记锁、备份导出和导入恢复入口。
- 当前日志导航会随列表分页更新，折叠日历后占据更多侧栏空间。
- 点击日历日期可查看当天日志。
- 月份筛选可查看整月日志。
- 新建日志会继承当前选中日期和有效分类筛选。
- 统计面板仍保留在更多工具模式中，包含本周工时、本月工时、日均、总记录和分类分布。

## AI

AI 相关设置、API Key 和历史会话默认保存在本机 `DATA_DIR`，不会写入前端源码。

### 独立 AI 对话

- 右下角 `AI` 浮动按钮进入独立 AI 对话页。
- 侧边栏切换到 AI 模式后显示全局历史对话。
- 支持新建、切换、重命名、删除历史对话。
- AI 设置是独立页面，包含基础设置、生图设置和技能设置。
- 支持 DeepSeek 模型、思考强度、流式输出、Tavily/Perplexity 联网搜索、WeStock 数据技能和 Seedream 生图设置。
- 普通发送只处理用户输入的对话内容，不读取日志、待办或分类。

### 日志内 AI

- 编辑器工具栏的 `AI` 按钮可打开日志内 AI 面板。
- 日志内 AI 会接收当前日志标题、正文和选区作为前端主动传入的上下文。
- AI 只返回回答和可应用建议，不会自动改日志。
- 用户点击后才会改标题、插入到光标、替换选区或替换全文。
- 日志内历史按当前日志隔离，不混入独立 AI 对话页。

### 生图

- 独立 AI 对话和日志内 AI 输入框都有显式 `生图` 按钮。
- 只有点击 `生图` 才进入图片生成流程；普通发送不会通过关键词自动识别生图意图。
- 生图会先用 DeepSeek 优化 prompt，然后展示确认卡片。
- 确认卡片可在原始 prompt 和优化 prompt 之间切换。
- 点击生成后调用 Seedream，图片会下载到本地 `uploads/`，再返回本地 Markdown 链接。
- 日志内生图可一键将 `![image](/uploads/...)` 插入当前光标位置。

### 联网搜索

- Tavily 和 Perplexity 都在 AI 设置的技能设置中配置。
- 开启后会用用户本轮最后一条问题自动搜索，再把结果作为只读上下文交给 DeepSeek。
- Tavily 和 Perplexity 可以同时开启；搜索结果会合并，单个搜索源失败不会阻断 AI 回复。
- Perplexity 自动搜索使用用户原问题，仅做空白清理和长度限制，不由模型改写 query。
- 回复下方会显示来源链接，并标明 `tavily` 或 `perplexity`。

### 技能

- WeStock 是手动选择技能，适合股票、ETF、指数、财报、资金流、日历等市场数据查询。
- 手动技能保持单选；选择技能后 AI 会生成确认执行卡片，用户点击确认后才调用工具。
- Perplexity 已迁移为自动联网搜索源，不再作为新对话的手动技能展示。

## Configuration

复制 `.env.example` 后可按需配置：

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP 服务端口 | `3000` |
| `DATA_DIR` | JSON 数据、设置、历史和上传图片保存目录 | `./data` |
| `AUTH_TOKEN` | 可选全站访问 token；留空则不启用 | disabled |
| `DIARY_PASSWORD_HASH` | 可选日记分类密码 SHA-256 哈希；留空则不启用 | disabled |
| `DEEPSEEK_API_KEY` | 服务端默认 DeepSeek API Key | empty |
| `DEEPSEEK_BASE_URL` | DeepSeek API 基础地址 | `https://api.deepseek.com` |
| `DEEPSEEK_DEFAULT_MODEL` | 默认 DeepSeek 模型 | `deepseek-v4-flash` |
| `TAVILY_API_KEY` | 服务端默认 Tavily API Key | empty |
| `TAVILY_BASE_URL` | Tavily API 基础地址 | `https://api.tavily.com` |
| `PERPLEXITY_API_KEY` | 服务端默认 Perplexity API Key | empty |
| `PERPLEXITY_BASE_URL` | Perplexity API 基础地址 | `https://api.perplexity.ai` |
| `SEEDREAM_API_KEY` | 服务端默认 Seedream API Key | empty |
| `SEEDREAM_BASE_URL` | Seedream API 基础地址 | `https://ark.cn-beijing.volces.com/api/v3` |
| `SEEDREAM_DEFAULT_MODEL` | 默认 Seedream 模型 | `doubao-seedream-5-0-260128` |
| `WESTOCK_NPX_COMMAND` | WeStock CLI 启动命令 | `npx -y westock-data-clawhub@1.0.4` |

生成日记密码哈希：

```bash
node -e "const crypto=require('crypto'); console.log(crypto.createHash('sha256').update('your-password').digest('hex'))"
```

如果启用 `AUTH_TOKEN`，页面登录密码就是该 token。请使用随机长字符串，并不要提交真实 `.env`。

## Data And Privacy

默认数据目录为 `data/`，可用 `DATA_DIR` 修改。

| File | Content |
| --- | --- |
| `logs.json` | 日志 |
| `todos.json` | 待办 |
| `categories.json` | 父分类、子分类和日历显示设置 |
| `ai-settings.json` | AI、Tavily、Perplexity、Seedream、WeStock 设置和本地 API Key |
| `ai-chats.json` | 独立 AI 和日志内 AI 历史 |
| `private-uploads.json` | 日记保护图片标记 |
| `uploads/` | 上传图片和生成图片 |

隐私边界：

- 后端 AI 聊天接口不会自行读取 `data/` 注入上下文。
- 独立 AI 对话只发送用户在对话框中输入的消息。
- 日志内 AI 只使用前端主动发送的当前日志上下文。
- Tavily 和 Perplexity 搜索只接收用户问题，不接收日志全文。
- `.env` 和 `data/` 已在 `.gitignore` 中排除，提交前仍建议用 `git status` 检查。

## Backup And Restore

- JSON 备份包含日志、待办、分类和私有上传标记。
- 上传图片和生成图片文件本身位于 `data/uploads/`，需要额外备份。
- 启用日记锁后，备份和恢复需要先解锁日记。
- 启用全站访问 token 后，需要通过页面登录或携带授权信息。

## Mobile Access

电脑和手机连接到同一局域网后，手机访问：

```text
http://<电脑局域网 IP>:<PORT>
```

例如 `http://192.168.1.4:3000`。首次访问前请确认 Windows 防火墙允许 Node.js 在专用网络通信。若在局域网外访问，请启用 `AUTH_TOKEN` 并使用可信隧道或组网。

## Template Variables

模板标题和正文以当前日志日期为基准：

| Syntax | Example | Description |
| --- | --- | --- |
| `{{今天}}` / `{{today}}` | `2026-05-27` | 当前日期 |
| `{{昨天}}` / `{{明天}}` | `2026-05-26` / `2026-05-28` | 相邻日期 |
| `{{日期:+7:MM月DD日}}` | `06月03日` | 日期偏移和自定义格式 |
| `{{本周:MM月DD日}}` | `05月25日 - 05月31日` | 本周区间 |
| `{{上一周:MM月DD日}}` | `05月18日 - 05月24日` | 上一周区间 |
| `{{上一周.开始:YYYY-MM-DD}}` | `2026-05-18` | 周区间开始 |
| `{{上一周.结束:YYYY-MM-DD}}` | `2026-05-24` | 周区间结束 |

同样支持 `{{下一周:...}}`、`{{date:...}}` 等对应写法。

## Development Notes

- 后端：Express + JSON 文件存储。
- 前端：原生 JavaScript 单页应用。
- 编辑器：CodeMirror 资源生成到未纳入版本控制的 `public/generated/editor/`。
- Markdown 渲染：本地前端模块封装 `marked`、KaTeX 和清洗逻辑。

## Relevant API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/logs?date=&month=&category=&search=&page=` | 查询日志 |
| `POST` | `/api/logs` | 新建日志 |
| `PUT` | `/api/logs/:id` | 更新日志 |
| `DELETE` | `/api/logs/:id` | 删除日志 |
| `GET` | `/api/todos` | 查询待办 |
| `POST` | `/api/todos` | 新建待办 |
| `PUT` | `/api/todos/:id` | 更新待办 |
| `DELETE` | `/api/todos/:id` | 删除待办 |
| `PUT` | `/api/todos/reorder` | 待办拖拽排序 |
| `GET` | `/api/categories` | 获取分类树 |
| `PUT` | `/api/categories/:parent/subcategories/reorder` | 重排父分类下的子分类 |
| `POST` | `/api/upload` | 上传日志图片 |
| `GET` | `/api/backup` | 导出 JSON 备份 |
| `POST` | `/api/restore` | 恢复 JSON 备份 |
| `GET` | `/api/ai/settings` | 读取 AI 设置 |
| `PUT` | `/api/ai/settings` | 保存 AI 设置 |
| `GET` | `/api/ai/skills` | 获取可手动选择的 AI 技能 |
| `POST` | `/api/ai/skills/:skill/run` | 确认执行 AI 技能工具 |
| `GET` | `/api/ai/conversations` | 读取 AI 历史 |
| `PUT` | `/api/ai/conversations` | 保存 AI 历史 |
| `POST` | `/api/ai/chat` | 独立 AI 对话 |
| `POST` | `/api/ai/editor` | 日志内 AI 建议 |
| `POST` | `/api/ai/image/prompt` | 生图 prompt 优化 |
| `POST` | `/api/ai/image/generate` | Seedream 生图并保存到本地 |
