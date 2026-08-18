# Work Log

本地优先、支持多账户隔离的工作日志、待办、倒数日、照片墙和 AI 辅助应用。它使用 JSON 文件保存数据，提供 Markdown/LaTeX 日志编辑、分类与日历、重复待办、账户级备份、图片上传，以及可选的 DeepSeek、Kimi、OpenRouter、Tavily、Perplexity、Seedream 和 WeStock 能力。

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

`npm start` 和 `npm test` 会自动构建编辑器资源；如果直接运行 `node server.js`，请先执行 `npm run build`。

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

- 默认首页已重构为 Agent / 知识库两个模式的双栏工作台：左侧管理会话或文档，右侧专注对话、编辑与阅读；任务仅作为 Agent 工具保留。
- 新增账户级知识文档、MiniSearch 本地检索、文件导入（Markdown/TXT/PDF/DOCX）和 ZIP 工作区备份。
- 新增独立 Agent Runtime、工具审批、分层记忆，以及可选的 Windows 受控执行和 Chrome 扩展桥。

- 新增独立 `/login`、24 小时 HttpOnly Cookie 会话和管理员创建的多账户体系。
- 每个账户拥有独立的日志、待办、倒数日、分类、上传、照片墙、AI 设置与历史、提醒配置、日记密码和备份恢复空间。
- 现有根目录数据会原地归属首次管理员；新账户保存到 `data/accounts/<UUID>/`。
- 管理员可创建、重命名、启停、设置角色和重置账户，但不能查看成员工作区。
- 待办页新增“倒数日”模式，支持一次性/每年重复日期、搜索、动态统计、跨年和闰年计算。
- 日志卡片新增分类内置顶；图片在日志卡片、详情预览和 AI 对话中支持双击放大。
- AI 历史和配置按账户持久化，新成员不会继承旧管理员的服务器级 AI Key。
- AI 对话新增 Kimi K3、K2.7 Code、K2.6，支持图片/视频理解与实验性 Kimi Formula 联网。
- 完整变更见 [ChangeLog.md](ChangeLog.md)。

## Main Areas

### 账户与登录

- 未登录访问 `/` 或 `/index.html` 会跳转到独立 `/login` 页面；API 返回 401 时前端统一回到登录页。
- 用户名为 3–32 位字母、数字、点、下划线或短横线，判重忽略大小写；登录密码使用 Node `crypto.scrypt` 和随机盐保存。
- 会话 Cookie 为 HttpOnly、SameSite=Strict，有效期 24 小时；磁盘中只保存令牌哈希、账户 ID 和过期时间。
- 新账户和管理员重置密码后的账户必须首次改密；修改或重置密码、停用账户都会撤销相关会话。
- 管理员可管理账户元数据，但没有成员工作区、备份、数据量或内容的读取入口。
- 普通成员可修改自己的显示名称、登录密码和日记密码。

### 日志

- 横向卡片列表：支持搜索、日期、月份、父分类、子分类和页码筛选；卡片区独立于顶部工具区。
- 分类筛选下支持多条日志置顶，最近置顶的卡片优先显示在分页结果最左侧；未选择分类时仍保持原有日期排序。
- 日志归档页：顶部使用单独的搜索/筛选模块，卡片区脱离外层大面板，主操作改为更紧凑的图标按钮。
- Markdown 编辑器：可选 CodeMirror 富编辑体验，同时保留原生 `textarea` 回退路径，支持语法高亮、查找、撤销、自动换行和自动保存。
- 预览模式：支持编辑、预览、分屏，以及 Markdown/LaTeX 渲染。
- 标题大纲：编辑页可展开当前 Markdown 的 `#` 至 `######` 标题树，并快速跳转。
- 全屏编辑：进入后只保留标题和正文编辑区，隐藏元信息、工具栏、预览切换、大纲和日志内 AI；退出后恢复进入前的编辑/预览状态。
- 图片：支持上传或直接粘贴 PNG、JPG、GIF、WebP、BMP 图片，并插入 Markdown 图片链接；卡片预览和编辑器详情预览均可双击图片放大。
- 模板：支持中文日期、日期偏移、周区间等占位符。

### 待办

- 侧边栏下拉选择 `待办事项` 后，右侧主体会切换到完整待办工作区。
- 页面可在“待办 / 倒数日”之间切换；倒数日独立保存标题、目标日期、每年重复和备注，并按香港业务日期显示剩余或已过天数。
- 主界面包含待办、今日、逾期、已完成统计。
- 支持按待办分类和已完成状态筛选，以及按标题和备注搜索；新增分类通过筛选栏的加号图标打开弹窗完成。
- 自定义分类可在分类标签内部点击垃圾桶图标删除，默认“待办”和“已完成”不显示删除入口。
- 当前分类下的未完成任务按截止日期优先展示；无截止日期任务排在后面。
- 任务可设置标题、截止日期、优先级、重复规则和备注；重复待办需要截止日期，完成后会保留当前记录为已完成，并自动生成下一期未完成待办。
- 支持勾选完成、点击编辑、删除、清除已完成和拖拽排序。
- 进入待办主页面时左侧侧栏切换为待办专用视图，只显示待办日历和邮件提醒设置。
- 待办侧栏日历会标记有截止日期的待办；点击日期不会筛选或跳转待办列表。
- 待办侧栏内置“邮件提醒”设置，可保存启用状态、收件邮箱和每日发送时间。
- 每日提醒按香港业务日期运行；到达设定时间后，会汇总所有待办分类中“当天到期且未完成”的待办。
- 若服务错过了当天设定时间，会在恢复运行后的首次检查补发一次；若当天没有符合条件的待办，则不会发邮件。
- 当天提醒建立快照后，后续重试会复用同一份内容，不会因设定时间之后新增或修改待办而改变当天邮件。
- 提醒邮件当前为 UTF-8 纯文本摘要，任务标题前会显示分类前缀，并保留截止日期和备注。

### 分类

- 分类管理通过侧边栏标题下拉进入。
- 支持一级分类、二级分类、拖拽排序、重命名和删除。
- 分类管理页采用白底细灰边和紧凑列表布局，新增、重命名、删除等操作使用黑白灰 SVG 图标按钮。
- 一级分类总数显示在分类侧栏标题右侧，侧栏列表不再显示日志数量和二级分类数量。
- 点击一级分类会直接进入二级分类侧栏和日志列表；有二级分类时自动打开第一个，没有时显示新增二级分类入口。
- 一级分类重命名和删除移动到左侧一级分类选中项内；受保护分类仍隐藏对应操作。
- 二级分类支持在浏览侧栏中新增、重命名、删除和拖拽排序；日志筛选二级分类会沿用该顺序。
- 从分类管理的二级分类日志列表打开日志时，侧栏会自动回到默认日志侧栏。
- 可为一级分类设置“日历显示”，控制点击日历某天时该分类日志是否参与显示。
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

### 照片墙

- 通过侧边栏模式菜单进入“照片墙”，左侧会切换为照片墙专用工具栏。
- 工具栏提供上传图片、放大、缩小、适应全部、重置视图、删除选中图片和图片数量。
- 主区域是 DOM 驱动的全幅无界画布：拖动画布可平移，滚轮可缩放；图片节点可拖动和右下角等比缩放。
- 当前缩放百分比显示在照片墙侧栏，右侧内容区不再显示额外标题。
- 每张图片下方可编辑一段文字评论，布局、尺寸、评论和层级保存到本机 `photo-wall.json`。
- 删除图片只移除照片墙节点，不删除 `/uploads/` 原文件，避免影响日志或 AI 中复用的图片。

## AI

AI 设置、加密后的 API Key 和历史会话保存在当前账户的数据目录，不会写入前端源码，也不会与其它账户共享。旧管理员可继续使用 `.env` 中的服务端回退 Key；新账户需要在各自的 AI 设置中配置 Key。

### 独立 AI 对话

- 通过侧边栏模式菜单进入独立 AI 对话页。
- 侧边栏切换到 AI 模式后显示全局历史对话，按今天、一周内和更久以前分组，并可在历史标题下按标题或全文搜索。
- 支持新建、切换、重命名、删除历史对话。
- 当前界面采用 Codex 工作台风格，消息阅读区铺开在白底工作区中，历史栏更紧凑，用户和 AI 消息都不显示头像，操作按钮统一为黑白灰，底部输入器更像命令框。
- 消息阅读区不再有外层边框；滚动仍由消息容器负责，底部输入器保留清晰边界。
- 用户问题悬浮时在问题框下方显示时间和复制按钮；AI 回答底部左侧并排显示复制按钮和时间。
- 新对话空白态会从精选名句池中按日期稳定轮换一句；扩展池仍保留 1000 条公版古典诗词。
- 长对话由消息容器自身滚动，发送后会自动滚到底部；不再依赖页面级 `overflow: hidden` 顶住布局。
- AI 设置是独立页面，包含基础设置、访问设置、生图设置和技能设置。
- 支持 DeepSeek、Kimi 直连模型和当前账户 OpenRouter Key 可访问的文本模型。OpenRouter 目录动态读取并缓存，模型选择器可按名称或完整 `author/model` ID 搜索，也可点击“刷新”立即重新拉取目录。
- 每个对话独立保存当前模型；新对话继承账户默认模型，在同一对话中切换供应商仍会保留可见历史上下文。
- 不同对话可以并行生成回答；当前对话生成时可切换到其他对话继续提问，历史列表会标记后台生成状态，完成或失败后按原对话保存并提示。
- 模型选择器展示来源、上下文长度、图片/视频能力和每百万 Token 价格；服务端会再次确认模型存在于当前账户目录，客户端不能指定供应商地址或 Base URL。
- 支持流式输出，并将供应商实际返回的思考/推理内容显示为消息内可折叠区域；流式推理实时展开，回答完成后默认收起。另支持 Tavily/Perplexity 联网搜索、WeStock 数据技能和 Seedream 生图设置。
- Kimi K3 固定最高推理；K2.7 Code 固定开启并保留思考；K2.6 可选择开启并保留思考或关闭。
- 独立对话与日志内 AI 均可附加图片或视频。附件按账户保存到 `ai-media/`，元数据保存到 `ai-media.json`；Kimi 每条消息最多 4 个、合计 100MB。
- OpenRouter 附件每条消息最多 4 个、原文件合计 25MB；单图不超过 10MB，单视频不超过 25MB，并且只有模型目录声明对应输入模态时才允许发送。
- 图片附件可双击放大，视频使用原生播放器。DeepSeek 不接收媒体，包含媒体的会话需要继续使用兼容的 Kimi/OpenRouter 模型或新建对话。
- 普通发送默认只处理用户输入的对话内容；开启日志访问后，会先把允许范围内日志的标题、日期、分类、工时和正文长度交给当前模型筛选，再由服务端用模型给出的正文检索词做本地补召回，只读取最终候选的完整正文。
- 用户明确要求分析“全部/所有/全量日志”时仍可读取权限范围内的全部正文；正文候选超过 8 批需要确认，超过 32 批会要求缩小分类范围。筛选、证据提取和合并阶段不会联网，也不会保存中间摘要。
- AI 回答中的 `[日志标题](#log/id)` 本地链接可点击打开对应日志。

### 日志内 AI

- 编辑器工具栏的 `AI` 按钮可打开日志内 AI 面板。
- 桌面端面板是可拖动浮窗，不会挤压正文编辑区；位置会保存在当前浏览器，双击标题栏可恢复默认位置。移动端使用底部弹层。
- 输入框与独立 AI 对话共用同一套可搜索模型目录；模型按日志内对话独立保存，新对话继承账户默认模型，切换后继续保留可见历史上下文。
- 当前对话模型同时用于日志问答和生图 Prompt 优化；图片、视频附件会依据该模型的输入模态在发送前校验。
- 日志内 AI 会接收当前日志标题、正文和选区作为前端主动传入的上下文。
- 日志内 AI 会优先使用当前编辑器上下文和用户消息，并始终带有今天日期。
- AI 只返回回答和可应用建议，不会自动改日志。
- 用户点击后才会改标题、插入到光标、替换选区或替换全文。
- 日志内历史按当前日志隔离，不混入独立 AI 对话页。

### 生图

- 独立 AI 对话和日志内 AI 输入框都有显式 `生图` 按钮。
- 只有点击 `生图` 才进入图片生成流程；普通发送不会通过关键词自动识别生图意图。
- 生图会先用当前选择的文本模型优化 prompt，然后展示确认卡片。
- 确认卡片可在原始 prompt 和优化 prompt 之间切换。
- 点击生成后调用 Seedream，图片会下载到本地 `uploads/`，再返回本地 Markdown 链接。
- 独立 AI 对话中的生成结果可双击图片放大查看；单击图片不触发动作。
- 日志内生图可一键将 `![image](/uploads/...)` 插入当前光标位置。

### 联网搜索

- Tavily 和 Perplexity 都在 AI 设置的技能设置中配置。
- 独立 AI 对话输入框左下角提供 Tavily 快捷开关；Perplexity 仍在设置页中开关。
- 开启后会用用户本轮最后一条问题自动搜索，再把结果作为只读上下文交给 DeepSeek。
- Tavily 和 Perplexity 可以同时开启；搜索结果会合并，单个搜索源失败不会阻断 AI 回复。
- Perplexity 自动搜索使用用户原问题，仅做空白清理和长度限制，不由模型改写 query。
- 回复下方会显示来源链接，并标明 `tavily` 或 `perplexity`。
- “Kimi 官方联网（实验）”开启后，Kimi 会改用官方 Formula `moonshot/web-search:latest`，并跳过 Tavily/Perplexity，避免重复检索和计费。
- K3 会在首轮强制联网；K2.7 Code 与开启思考的 K2.6 只能由模型自动判断是否搜索。Formula 失败不会自动降级，也不会返回残缺回答。
- Formula 当前处于实验/升级阶段，可能限流或产生额外费用，不建议作为唯一的生产搜索链路。其加密上下文只在隐藏的供应商续传数据中使用，不显示、复制或进入备份。
- OpenRouter 模型开启联网时使用官方 `openrouter:web_search` Beta 工具，基础/高级搜索分别最多取 5/10 个结果，并把 `url_citation` 映射为来源链接；不会预先调用或失败后回退 Tavily/Perplexity。
- OpenRouter 默认请求零数据保留端点（ZDR）；关闭该账户设置后才允许普通路由。ZDR 可能减少当前模型的可用供应商。

### 技能

- WeStock 是手动选择技能，适合股票、ETF、指数、财报、资金流、日历等市场数据查询。
- 手动技能保持单选；选择技能后 AI 会生成确认执行卡片，用户点击确认后才调用工具。
- Perplexity 已迁移为自动联网搜索源，不再作为新对话的手动技能展示。

## Configuration

复制 `.env.example` 后可按需配置：

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP 服务端口 | `3000` |
| `HOST` | 监听地址；对外监听时必须启用账户认证 | `127.0.0.1` |
| `DATA_DIR` | 用户注册表、账户数据和上传图片保存目录 | `./data` |
| `AUTH_TOKEN` | 仅在没有 `users.json` 时初始化 `admin` 的一次性密码 | required on first start |
| `DEEPSEEK_API_KEY` | 旧管理员工作区可使用的服务端 DeepSeek 回退 Key | empty |
| `DEEPSEEK_BASE_URL` | DeepSeek API 基础地址 | `https://api.deepseek.com` |
| `DEEPSEEK_DEFAULT_MODEL` | 默认 DeepSeek 模型 | `deepseek-v4-flash` |
| `MOONSHOT_API_KEY` | 旧管理员工作区可使用的服务端 Moonshot 回退 Key | empty |
| `MOONSHOT_BASE_URL` | Moonshot API 基础地址 | `https://api.moonshot.cn/v1` |
| `OPENROUTER_API_KEY` | 旧管理员工作区可使用的服务端 OpenRouter 回退 Key | empty |
| `AI_SECRETS_KEY_FILE` | 账户 AI Key 的 AES-256-GCM 主密钥文件路径；留空使用系统配置目录 | platform default |
| `TAVILY_API_KEY` | 旧管理员工作区可使用的服务端 Tavily 回退 Key | empty |
| `TAVILY_BASE_URL` | Tavily API 基础地址 | `https://api.tavily.com` |
| `PERPLEXITY_API_KEY` | 旧管理员工作区可使用的服务端 Perplexity 回退 Key | empty |
| `PERPLEXITY_BASE_URL` | Perplexity API 基础地址 | `https://api.perplexity.ai` |
| `SEEDREAM_API_KEY` | 旧管理员工作区可使用的服务端 Seedream 回退 Key | empty |
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

### 首次迁移说明

- 如果 `DATA_DIR` 中还没有 `users.json`，启动时必须提供 `AUTH_TOKEN`。
- 服务会先检查现有 JSON 数据，再原子创建 `admin` 账户；现有日志、待办、分类、照片墙、AI 历史和上传文件不会移动。
- 旧的 `AUTH_TOKEN` 可以是现有 6 位密码，但它只作为一次性密码；首次登录后必须换成至少 10 个字符的新密码。
- 创建用户注册表后，`AUTH_TOKEN` 不再覆盖账户配置，可以从 `.env` 删除。
- `users.json` 或 `auth-sessions.json` 损坏时，服务会保留 `.corrupt-*.bak` 副本并拒绝登录，不会降级成无密码模式。

## 隐藏日记

- 日记分类（`日记` 及其子分类）**始终隐藏**，界面上不提供任何解锁/锁定按钮。
- 在搜索框输入「如意如意」（与 `server.js` 中的 `DIARY_MAGIC_PHRASE` 保持一致）即可解锁并自动进入日记列表；再次输入同一暗语则重新锁定。
- 解锁状态通过 `diary_session` Cookie 维持（24 小时有效），且按账户隔离；备份/恢复、AI 上下文等涉及日记数据的操作同样受此保护。
- 暗语是固定写入代码的，属个人应用的“安全通过隐蔽”手段，无法作为普通搜索词使用。

## Data And Privacy

默认数据目录为 `data/`，可用 `DATA_DIR` 修改。首次管理员继续使用根目录中的原有文件；新账户的数据位于 `accounts/<storage_key>/`，其内部文件结构与管理员工作区相同。

| File | Content |
| --- | --- |
| `users.json` | 账户 ID、用户名、显示名称、角色、状态、scrypt 密码哈希和存储目录键 |
| `auth-sessions.json` | 会话令牌哈希、账户 ID、创建时间和过期时间 |
| `logs.json` | 日志 |
| `todos.json` | 待办 |
| `countdowns.json` | 独立倒数日 |
| `todo-categories.json` | 待办分类 |
| `todo-reminder-settings.json` | 待办提醒开关、收件邮箱和发送时间 |
| `todo-reminder-state.json` | 当天提醒快照、发送状态和错误信息 |
| `categories.json` | 父分类、子分类和日历显示设置 |
| `photo-wall.json` | 照片墙图片节点、位置、尺寸、评论和层级 |
| `ai-settings.json` | DeepSeek、Moonshot、OpenRouter、Tavily、Perplexity、Seedream、WeStock 设置和 AES-256-GCM 加密后的账户 API Key |
| `ai-chats.json` | 独立 AI 和日志内 AI 历史 |
| `ai-media.json` | AI 图片/视频附件元数据、会话引用和 Moonshot 文件映射 |
| `ai-media/` | AI 对话上传的图片和视频本地副本 |
| `private-uploads.json` | 日记保护图片标记 |
| `uploads/` | 上传图片和生成图片 |
| `accounts/<UUID>/` | 新账户的独立工作区数据和上传目录 |

隐私边界：

- 所有工作区 API 都从当前 Cookie 会话解析账户，客户端不能通过传入用户 ID 切换数据目录。
- 管理员接口只返回账户元数据，不提供成员日志、统计、AI 历史、备份或进入成员工作区的接口。
- 相同记录 ID 或相同上传文件名只在各自账户目录内解析，不能跨账户读取、修改或删除。
- 新账户不会继承旧管理员的服务端 AI Key；每个账户可在自己的 AI 设置中保存独立 Key。
- 账户 AI Key 使用随机 nonce 的 AES-256-GCM 加密，认证附加数据绑定账户和字段。主密钥默认位于 Windows `%LOCALAPPDATA%\work-log\ai-secrets.key` 或其它系统的用户配置目录；发现加密数据但主密钥丢失/错误时服务会拒绝启动。
- 迁移机器时必须将主密钥文件通过独立安全渠道一并复制；它不会进入工作区 JSON 备份，也不应提交到仓库。
- 后端 AI 聊天接口只有在用户开启日志访问时，才会按访问设置建立当前账户的一致日志快照；元数据筛选返回的 ID 和确认重试提交的 ID 都会在服务端按最新分类与日记权限重新校验。
- 日记内容还需要同时满足“允许 AI 访问日记内容”和日记已解锁。
- 独立 AI 对话可使用允许范围内的日志上下文，并提示模型用 `#log/id` 返回本地日志链接。
- 日志内 AI 只使用前端主动发送的当前日志上下文，不会额外读取其它日志。
- Tavily 和 Perplexity 搜索只接收用户问题，不接收日志全文。
- Kimi 官方联网开启后，查询及工具上下文会发送给 Moonshot Formula；该实验能力不会自动回退到其它搜索服务。
- OpenRouter 官方联网开启后，当前问题会交给 OpenRouter Web Search Beta 工具；引用链接来自上游 annotations，失败不会切换供应商。
- AI 图片和视频按账户保存在 `ai-media/`，只通过已认证的媒体接口预览；发送给 Kimi 时上传至 Moonshot Files API，发送给 OpenRouter 时从私有本地副本生成 Data URL。
- 日记解锁 Cookie 同时绑定账户 ID；另一个账户即使携带相同 Cookie 值也不能解锁。
- `.env` 和 `data/` 已在 `.gitignore` 中排除，提交前仍建议用 `git status` 检查。

## Backup And Restore

- JSON 备份只包含当前账户的日志、待办、倒数日、分类、照片墙和私有上传标记。
- 备份不包含 `users.json`、密码哈希、会话或其它账户的数据。
- 上传图片、生成图片及 AI 媒体二进制分别位于当前账户的 `uploads/` 和 `ai-media/`，需要额外备份。
- AI 对话历史、AI 设置、AI 媒体元数据和 Moonshot 远端文件映射不在现有 JSON 备份范围内。
- AI 主密钥文件从不进入 JSON 备份；迁移部署时必须单独安全备份和恢复。
- 启用日记锁后，备份和恢复需要先解锁日记。
- 恢复支持替换和合并；不含倒数日、置顶字段等新字段的旧备份继续兼容。
- 所有备份与恢复接口都要求当前账户的有效 Cookie 会话。
- JSON 备份标记为 `format: structure`，只含结构数据；完整附件请使用 `/api/workspace/export` 的 ZIP 工作区备份。

## Chrome 扩展与 Windows 原生执行

- 仓库 `chrome-extension/` 是 Manifest V3 扩展。在 Chrome 打开 `chrome://extensions`，启用开发者模式后加载该目录。
- 扩展只与 `127.0.0.1` / `localhost` 的应用页通信，并通过配对码绑定。Agent 只能控制用户明确附加的标签页，不会使用远程调试端口。
- Windows 电脑工具默认关闭。管理员需在本机环回访问中重新输入密码，并配置目录白名单后才会开放文件和 `code.run`。
- PowerShell / Python 一旦确认执行，即拥有当前 Windows 用户权限；目录白名单无法约束脚本内部自行访问其他路径。这不是安全沙箱。

## Agent 工作台（当前默认入口）

首页只有 Agent 和知识库两个模式，桌面端使用固定侧栏，窄屏自动切换为抽屉。Agent 模式的左侧按时间分组管理会话，右侧显示对话、运行轨迹、审批和记忆建议；知识库模式的左侧以“知识库 → 文件夹 → 文档”树统一管理所有知识，笔记、旧日志和导入文件混排，右侧编辑 Markdown 或只读查看文件正文。当前位置保存在 `#agent/:sessionId`、`#knowledge?base=...&folder=...` 或 `#knowledge/:documentId` Hash 路由中，知识引用可以直接打开并定位文档。

知识库根节点沿用原有一级分类，原有带路径的分类映射为对应知识库下的文件夹；没有明确位置的新笔记和导入文件默认进入“其他”。新列表不按来源或文件格式筛选，`sourceType` 只在后端适配和权限判断中保留。知识树可新建、重命名和归档知识库/文件夹，`GET /api/knowledge/tree` 返回当前账户可见的树和文档数量。旧日志仍以 `logs.json` 为权威数据源，在新编辑器中只编辑标题、正文和日期，工时与置顶字段保持不变。

任务不再占用首页入口，仍可由 Agent 在确认后创建、更新或完成。旧日志、待办、照片墙、模型设置与备份界面完整保留在 `/legacy.html`，可从新首页的“设置 → 打开旧版功能”进入。Agent 的本地检索不会把锁定日记加入索引结果，修改知识、任务写入、代码运行和浏览器写操作会先显示确认卡。

知识文档接口为 `/api/knowledge/documents`、`/api/knowledge/search` 和 `/api/knowledge/imports`；文件原件只从认证接口 `/api/knowledge/files/:id/content` 读取。Agent 会话和运行记录分别保存到当前账户的 `agent-sessions.json` 与 `agent-runs.json`，长期记忆先写入提案，确认后才进入 `agent-memories.json`。完整 ZIP 工作区还会包含知识原件、上传图片、AI 媒体、Agent 资产和会话记忆。

## Mobile Access

先在本机完成管理员初始化和首次改密，再将 `HOST` 设置为 `0.0.0.0`。电脑和手机连接到同一局域网后，手机访问：

```text
http://<电脑局域网 IP>:<PORT>
```

例如 `http://192.168.1.4:3000`。首次访问前请确认 Windows 防火墙允许 Node.js 在专用网络通信。账户认证始终生效，不需要继续保留 `AUTH_TOKEN`。若在局域网外访问，请使用 HTTPS 反向代理、可信隧道或组网，不要直接暴露未加密的 HTTP 端口。

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

- 后端：Express + JSON 文件存储；数据库通过工厂按账户数据目录创建实例。
- 前端：原生 JavaScript 单页应用。
- 编辑器：CodeMirror 资源生成到未纳入版本控制的 `public/generated/editor/`。
- Markdown 渲染：本地前端模块封装 `marked`、KaTeX 和清洗逻辑。
- 认证：scrypt 密码哈希、持久化会话令牌哈希、HttpOnly Cookie；不再支持旧 Bearer `AUTH_TOKEN`。
- 路由顺序：`/api/logs/reorder`、`/api/todos/reorder` 等固定路径必须定义在对应 `/:id` 路由之前。

## Relevant API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 登录并签发 Cookie 会话 |
| `GET` | `/api/auth/check` | 查询登录状态，用于登录页和前端启动检查 |
| `POST` | `/api/auth/logout` | 退出并撤销当前会话 |
| `GET` | `/api/auth/me` | 获取当前账户 |
| `PATCH` | `/api/auth/me` | 修改当前账户显示名称 |
| `PUT` | `/api/auth/password` | 修改当前账户登录密码 |
| `PUT` | `/api/auth/diary/password` | 启用、修改或关闭当前账户日记密码 |
| `POST` | `/api/auth/diary` | 使用当前账户的日记密码解锁 |
| `POST` | `/api/auth/diary/lock` | 锁定当前账户的日记内容 |
| `GET` | `/api/auth/diary/status` | 查询当前账户的日记锁状态 |
| `GET` | `/api/admin/users` | 管理员获取账户列表 |
| `POST` | `/api/admin/users` | 管理员创建账户和临时密码 |
| `PATCH` | `/api/admin/users/:id` | 管理员修改用户名、显示名称、角色或状态 |
| `POST` | `/api/admin/users/:id/reset-password` | 管理员重置临时密码并撤销会话 |
| `GET` | `/api/logs?date=&month=&category=&search=&page=` | 查询日志 |
| `POST` | `/api/logs` | 新建日志 |
| `PUT` | `/api/logs/:id` | 更新日志（含 `pinned` 置顶状态） |
| `DELETE` | `/api/logs/:id` | 删除日志 |
| `GET` | `/api/todos` | 查询待办 |
| `POST` | `/api/todos` | 新建待办 |
| `PUT` | `/api/todos/:id` | 更新待办 |
| `DELETE` | `/api/todos/:id` | 删除待办 |
| `PUT` | `/api/todos/reorder` | 待办拖拽排序 |
| `GET` | `/api/countdowns` | 查询当前账户倒数日 |
| `POST` | `/api/countdowns` | 新建倒数日 |
| `PUT` | `/api/countdowns/:id` | 更新倒数日 |
| `DELETE` | `/api/countdowns/:id` | 删除倒数日 |
| `GET` | `/api/todo-reminder-settings` | 读取待办邮件提醒设置与状态 |
| `PUT` | `/api/todo-reminder-settings` | 保存待办邮件提醒设置 |
| `GET` | `/api/categories` | 获取分类树 |
| `PUT` | `/api/categories/:parent/subcategories/reorder` | 重排父分类下的子分类 |
| `POST` | `/api/upload` | 上传日志图片 |
| `GET` | `/api/photo-wall` | 获取照片墙图片节点 |
| `POST` | `/api/photo-wall/items` | 创建照片墙图片节点 |
| `PUT` | `/api/photo-wall/items/:id` | 更新照片墙图片位置、尺寸、评论或层级 |
| `DELETE` | `/api/photo-wall/items/:id` | 从照片墙移除图片节点 |
| `PUT` | `/api/photo-wall/items/reorder` | 重排照片墙图片层级 |
| `GET` | `/api/backup` | 导出 JSON 备份 |
| `POST` | `/api/restore` | 恢复 JSON 备份 |
| `GET` | `/api/ai/settings` | 读取 AI 设置 |
| `PUT` | `/api/ai/settings` | 保存 AI 设置 |
| `GET` | `/api/ai/models` | 获取当前账户可用的直连与 OpenRouter 模型目录 |
| `GET` | `/api/ai/skills` | 获取可手动选择的 AI 技能 |
| `POST` | `/api/ai/skills/:skill/run` | 确认执行 AI 技能工具 |
| `GET` | `/api/ai/conversations` | 读取 AI 历史 |
| `PUT` | `/api/ai/conversations` | 保存 AI 历史 |
| `POST` | `/api/ai/chat` | 独立 AI 对话 |
| `POST` | `/api/ai/editor` | 日志内 AI 建议 |
| `POST` | `/api/ai/media` | 上传账户隔离的 AI 图片或视频附件 |
| `GET` | `/api/ai/media/:id/content` | 认证预览 AI 媒体，视频支持 Range |
| `DELETE` | `/api/ai/media/:id` | 删除未被会话引用的 AI 媒体 |
| `POST` | `/api/ai/image/prompt` | 生图 prompt 优化 |
| `POST` | `/api/ai/image/generate` | Seedream 生图并保存到本地 |
| `GET/POST` | `/api/knowledge/documents` | 查询或创建知识文档 |
| `GET/PATCH` | `/api/knowledge/documents/:id` | 读取或更新知识文档 |
| `GET/PUT` | `/api/knowledge/documents/:id/annotation` | 读取或保存导入文件的关联笔记 |
| `POST` | `/api/knowledge/documents/:id/archive` | 归档知识文档 |
| `POST` | `/api/knowledge/imports` | 导入 Markdown、TXT、PDF 或 DOCX |
| `GET` | `/api/knowledge/search` | 本地分块检索并返回引用定位 |
| `GET` | `/api/knowledge/files/:id/content` | 认证读取知识原文件 |
| `GET/POST` | `/api/agent/sessions` | Agent 会话列表与创建 |
| `GET/PATCH` | `/api/agent/sessions/:id` | 读取完整会话，或重命名/归档会话 |
| `POST` | `/api/agent/sessions/:id/messages` | 创建一次 Agent 运行 |
| `GET` | `/api/agent/runs/:id/events` | SSE 运行事件流 |
| `POST` | `/api/agent/runs/:id/approvals/:approvalId` | 批准或拒绝动作 |
| `POST` | `/api/agent/runs/:id/cancel` | 取消运行 |
| `GET` | `/api/agent/memories` | 查询已确认的 L2/L3 记忆 |
| `POST` | `/api/agent/memory-proposals/:id/approve` | 确认长期记忆提案 |
| `GET/PUT` | `/api/admin/agent-policy` | 管理电脑工具开关与目录白名单 |
| `GET` | `/api/workspace/export` | 导出完整 ZIP 工作区 |
| `POST` | `/api/workspace/restore` | 恢复 ZIP 或旧 JSON |

除登录和登录状态检查外，工作区 API 都要求有效的 `site_session` Cookie；`/api/admin/*` 还要求管理员角色。处于强制改密状态的会话只能查询或修改当前账户、修改密码和退出。

日志记录包含服务端维护的 `pinned` 与 `pinned_at` 字段。分类筛选时，置顶日志会在分页前优先排列；未选择分类时保持原有日期排序。
