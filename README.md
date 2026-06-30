# Work Log

本地优先的工作日志、待办和 AI 辅助应用。它用 JSON 文件保存数据，提供 Markdown/LaTeX 日志编辑、分类管理、日历浏览、待办主界面、图片上传、模板、备份恢复，以及可选的 DeepSeek、Tavily、Perplexity、Seedream 和 WeStock 能力。

更新记录见 [ChangeLog.md](ChangeLog.md)。

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

待办提醒测试命令：

```bash
npm run todo:reminder:test -- --to your@email.com --all-open
```

只预览正文、不真正发送：

```bash
npm run todo:reminder:test -- --to your@email.com --all-open --dry-run
```

## Recent Updates

- 待办入口文案统一为“待办事项”；待办页左侧侧栏现在只显示待办日历和邮件提醒设置。
- 待办页统计改为标题行右侧的小卡片，分类添加改为 SVG 图标按钮打开弹窗。
- 待办侧栏邮件提醒改为上下两行输入，收件邮箱和提醒时间不再挤在同一行。
- 分类管理页同步为 Codex 工作台风格：白底细灰边、紧凑列表、黑白灰操作按钮和低装饰图谱。
- 待办新增“不重复 / 每日 / 每周 / 每月 / 每年”选项；完成重复待办后会自动生成下一期待办。
- 待办分类删除入口改为分类标签内部的垃圾桶 SVG 按钮，不再显示小圆 `×`。
- 待办日历会标记有截止日期的待办，点击日期只更新日历焦点，不会筛选或跳转待办列表。
- 邮件提醒设置已从待办右侧编辑表单移到左侧待办侧栏，保存逻辑和后端接口保持不变。
- 日志页标题行统计卡片已删除；统计接口仍用于刷新日志日历中的有日志日期。
- AI 对话页现在采用 Codex 工作台风格：白底、细灰边、列表式历史栏、黑白灰操作按钮、无头像 AI 回答和底部命令框输入器。
- 修复了独立 AI 对话页的消息区滚动问题，长对话会由主消息容器负责滚动，自动滚底也跟着恢复正常。
- 日志归档页已收成“工具区 + 卡片区”的结构：搜索和筛选保留在上方，日志卡片不再被整块大白框包裹。
- 日志编辑器内 AI 面板改成更紧凑的头部和输入区，历史、设置、新对话、生图、发送入口都还保留。

## Main Areas

### 日志

- 横向卡片列表：支持搜索、日期、月份、父分类、子分类和页码筛选；卡片区独立于顶部工具区。
- 日志归档页：顶部使用单独的搜索/筛选模块，卡片区脱离外层大面板，主操作改为更紧凑的图标按钮。
- Markdown 编辑器：可选 CodeMirror 富编辑体验，同时保留原生 `textarea` 回退路径，支持语法高亮、查找、撤销、自动换行和自动保存。
- 预览模式：支持编辑、预览、分屏，以及 Markdown/LaTeX 渲染。
- 标题大纲：编辑页可展开当前 Markdown 的 `#` 至 `######` 标题树，并快速跳转。
- 全屏编辑：保留核心写作和预览控件，隐藏元信息和管理操作。
- 图片：支持上传或直接粘贴 PNG、JPG、GIF、WebP、BMP 图片，并插入 Markdown 图片链接。
- 模板：支持中文日期、日期偏移、周区间等占位符。

### 待办

- 侧边栏下拉选择 `待办事项` 后，右侧主体会切换到完整待办工作区。
- 主界面包含待办、今日、逾期、已完成统计。
- 支持按待办分类和已完成状态筛选，以及按标题和备注搜索；新增分类通过筛选栏的加号图标打开弹窗完成。
- 自定义分类可在分类标签内部点击垃圾桶图标删除，默认“待办”和“已完成”不显示删除入口。
- 当前分类下的未完成任务按截止日期优先展示；无截止日期任务排在后面。
- 任务可设置标题、截止日期、优先级、重复规则和备注；重复待办需要截止日期，完成后会保留当前记录为已完成，并自动生成下一期未完成待办。
- 支持勾选完成、点击编辑、删除、清除已完成和拖拽排序。
- 进入待办主页面时左侧侧栏切换为待办专用视图，只显示待办日历和邮件提醒设置。
- 待办侧栏日历会标记有截止日期的待办；点击日期不会筛选或跳转待办列表。
- 待办侧栏内置“邮件提醒”设置，可保存启用状态、收件邮箱和每日发送时间。
- 每日提醒按香港业务日期运行；到达设定时间后，只汇总“当天到期且未完成”的待办。
- 若服务错过了当天设定时间，会在恢复运行后的首次检查补发一次；若当天没有符合条件的待办，则不会发邮件。
- 当天提醒建立快照后，后续重试会复用同一份内容，不会因设定时间之后新增或修改待办而改变当天邮件。
- 提醒邮件当前为 UTF-8 纯文本摘要，只包含标题、截止日期和备注。

### 分类

- 分类管理通过侧边栏标题下拉进入。
- 支持父分类、子分类、拖拽排序、重命名和删除。
- 分类管理页采用白底细灰边和紧凑列表布局，新增、重命名、删除等操作使用黑白灰 SVG 图标按钮。
- 子分类支持在父分类详情中拖拽排序；日志筛选二级分类会沿用该顺序。
- 父分类和子分类显示日志数量。
- 父分类详情支持“列表 / 图谱”切换；图谱以星系式布局展示当前父分类和子分类关系，并可点击子分类进入浏览。
- 从分类管理的子分类日志列表打开日志时，侧栏会自动回到默认日志侧栏。
- 可为父分类设置“日历显示”，控制点击日历某天时该分类日志是否参与显示。
- 月份筛选、分类筛选和工时统计不会因“日历显示”关闭而丢失日志。

### 默认侧栏与日历

- 默认侧栏显示可收起日历和当前日志导航。
- 日历收起后只显示日期和星期几，并会一起收起日记锁、备份导出和导入恢复入口。
- 当前日志导航会随列表分页更新，折叠日历后占据更多侧栏空间。
- 点击日历日期可查看当天日志。
- 月份筛选可查看整月日志。
- 筛选到锁定的日记分类时，日志列表中间会显示“解锁日记”入口；解锁后保留当前筛选并刷新。
- 新建日志会继承当前选中日期和有效分类筛选。
- 日志统计卡片和旧侧栏统计面板已移除；统计接口仍用于刷新日历上的有日志日期标记。

## AI

AI 相关设置、API Key 和历史会话默认保存在本机 `DATA_DIR`，不会写入前端源码。

### 独立 AI 对话

- 通过侧边栏模式菜单进入独立 AI 对话页。
- 侧边栏切换到 AI 模式后显示全局历史对话，并可在历史标题下按标题或全文搜索。
- 支持新建、切换、重命名、删除历史对话。
- 当前界面采用 Codex 工作台风格，消息阅读区铺开在白底工作区中，历史栏更紧凑，AI 回答不显示头像，用户头像和操作按钮统一为黑白灰，底部输入器更像命令框。
- 新对话空白态会从精选名句池中按日期稳定轮换一句；扩展池仍保留 1000 条公版古典诗词。
- 长对话由消息容器自身滚动，发送后会自动滚到底部；不再依赖页面级 `overflow: hidden` 顶住布局。
- AI 设置是独立页面，包含基础设置、访问设置、生图设置和技能设置。
- 支持 DeepSeek 模型、思考强度、流式输出、Tavily/Perplexity 联网搜索、WeStock 数据技能和 Seedream 生图设置。
- 普通发送默认只处理用户输入的对话内容；开启日志访问后，会按访问设置读取允许的日志分类和子分类。
- AI 回答中的 `[日志标题](#log/id)` 本地链接可点击打开对应日志。

### 日志内 AI

- 编辑器工具栏的 `AI` 按钮可打开日志内 AI 面板。
- 面板采用右侧固定分栏；头部、历史入口、新对话和输入动作做了紧凑化处理，减少说明性噪音。
- 日志内 AI 会接收当前日志标题、正文和选区作为前端主动传入的上下文。
- 日志内 AI 会优先使用当前编辑器上下文和用户消息，并始终带有今天日期。
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
- 独立 AI 对话输入框左下角提供 Tavily 快捷开关；Perplexity 仍在设置页中开关。
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
| `QQ_EMAIL_ACCOUNT` | QQ 发信邮箱账号；默认也可作为提醒收件邮箱初始值 | empty |
| `QQ_EMAIL_AUTH_CODE` | QQ 邮箱 SMTP 授权码，不是登录密码 | empty |

### 待办邮件提醒配置

1. 在 QQ 邮箱中开启 SMTP，并获取授权码。
2. 在 `.env` 中填写：

```bash
QQ_EMAIL_ACCOUNT=your@qq.com
QQ_EMAIL_AUTH_CODE=your-smtp-auth-code
```

3. 重启服务。
4. 打开待办页面，在“邮件提醒”卡片中设置启用状态、收件邮箱和发送时间，默认时间是 `08:00`。
5. 保存后，服务会每 60 秒检查一次是否需要发送。

提醒发送边界：

- 只有启用状态为开且 QQ 发信配置可用时，提醒设置才能保存成功。
- 只提醒“当天到期且未完成”的待办。
- 当天无符合条件的待办时不发邮件。
- SMTP 失败会重试同一份当天快照，直到成功或服务停止。

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
| `todo-reminder-settings.json` | 待办提醒开关、收件邮箱和发送时间 |
| `todo-reminder-state.json` | 当天提醒快照、发送状态和错误信息 |
| `categories.json` | 父分类、子分类和日历显示设置 |
| `ai-settings.json` | AI、Tavily、Perplexity、Seedream、WeStock 设置和本地 API Key |
| `ai-chats.json` | 独立 AI 和日志内 AI 历史 |
| `private-uploads.json` | 日记保护图片标记 |
| `uploads/` | 上传图片和生成图片 |

隐私边界：

- 后端 AI 聊天接口只有在用户开启日志访问时，才会按访问设置读取允许的日志分类和子分类。
- 日记内容还需要同时满足“允许 AI 访问日记内容”和日记已解锁。
- 独立 AI 对话可使用允许范围内的日志上下文，并提示模型用 `#log/id` 返回本地日志链接。
- 日志内 AI 只使用前端主动发送的当前日志上下文，不会额外读取其它日志。
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
| `GET` | `/api/todo-reminder-settings` | 读取待办邮件提醒设置与状态 |
| `PUT` | `/api/todo-reminder-settings` | 保存待办邮件提醒设置 |
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
