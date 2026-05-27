# Work Log

一个本地优先的工作日志和待办应用，支持 Markdown/LaTeX 日志编辑、分类管理、日历浏览、统计、图片上传、日志模板、数据备份恢复以及可选的访问保护和日记锁定。

## Features

- 日志编辑：桌面与手机统一使用 CodeMirror Markdown 编辑器，支持语法高亮、查找、撤销、预览、分屏、专注全屏编辑与自动保存。
- 编辑工具栏：支持常用 Emoji 快速插入，也可将剪贴板图片直接粘贴上传并插入 Markdown 图片链接。
- 日历与筛选：按日期或月份查看日志，分类筛选框随内容自适应宽度；新建日志会继承当前选中日期和分类筛选。
- 分类管理：管理父分类与子分类；每个父分类可通过“日历显示”开关决定其日志是否在按日查看时出现，月份筛选不受影响。
- 日志模板：支持今天、昨天、明天、日期偏移和周区间占位符。
- 工作辅助：待办事项、工时统计、CSV 导出、JSON 备份与恢复。
- 隐私保护：支持全站访问 token 与独立的日记分类锁定。

## Requirements

- Node.js >= 20.19.0
- npm

## Quick Start

```bash
npm install
copy .env.example .env
npm start
```

`copy` 适用于 Windows；macOS 或 Linux 可使用 `cp .env.example .env`。不创建 `.env` 也可以直接运行，应用默认监听 `http://localhost:3000`。

`npm start` 会先构建 CodeMirror 编辑器资源，再启动服务。日志正文编辑在桌面与手机上共享 Markdown 高亮、行号、查找替换和自动换行能力，并随应用主题切换配色。

## Mobile Access

电脑和手机连接到同一局域网后，在手机浏览器访问 `http://<电脑局域网 IP>:<PORT>`，例如 `http://192.168.1.4:3000`。首次访问前请确认 Windows 防火墙允许 Node.js 在专用网络中通信；在局域网以外提供访问时，请启用 `AUTH_TOKEN` 并使用受保护的组网或隧道。

手机端使用紧凑顶部操作栏，默认优先显示日志内容。点击“工作日志”标题展开或收起日历；标题栏中的导航、待办和“更多工具”按钮分别按需打开对应面板，“更多工具”中包含统计、日记锁定和备份恢复。点击右侧收起按钮可隐藏整个顶部区域，收起后点击左上角展开按钮即可恢复；收起状态不会在刷新后保留。

## Editor And Templates

在日志编辑器中，可以通过图片按钮上传图片，也可以在正文编辑区域直接粘贴 PNG、JPG、GIF、WebP 或 BMP 图片。上传完成后应用会在光标位置插入 Markdown 图片语法。工具栏内置 `✅`、`📌`、`💡`、`⚠️` 和 `🚀` 快速插入按钮。

点击编辑页顶部的“全屏编辑”可进入专注写作模式。全屏状态仅保留“返回”“退出全屏”、`编辑 / 预览 / 分屏` 切换、Markdown 快捷工具栏以及正文或预览区域；标题、日期分类信息、模板入口和其他管理操作会暂时隐藏。按 `Esc` 会优先退出全屏并停留在当前日志编辑页。

模板标题和正文支持以下占位符，以当前日志日期为基准进行格式化：

| Syntax | Example output | Description |
| --- | --- | --- |
| `{{今天}}` / `{{today}}` | `2026-05-27` | 当前日期 |
| `{{昨天}}` / `{{明天}}` | `2026-05-26` / `2026-05-28` | 相邻日期 |
| `{{日期:+7:MM月DD日}}` | `06月03日` | 日期偏移和自定义格式 |
| `{{本周:MM月DD日}}` | `05月25日 - 05月31日` | 本周周一至周日区间 |
| `{{上一周:MM月DD日}}` | `05月18日 - 05月24日` | 上一周区间 |
| `{{上一周.开始:YYYY-MM-DD}}` | `2026-05-18` | 周区间开始日期 |
| `{{上一周.结束:YYYY-MM-DD}}` | `2026-05-24` | 周区间结束日期 |

同样支持 `{{下一周:...}}`、`{{date:...}}` 等对应写法。

## Calendar Category Visibility

在“管理分类”页面中，选择父分类后可使用“日历显示”开关控制按日浏览行为：

- 开启：点击日历中的某一天时，会显示该分类及其子分类的日志。
- 关闭：按日查看时隐藏该父分类及其子分类日志，并且日历高亮日期会同步排除仅含隐藏分类的日期。
- 月份筛选、分类筛选与工时汇总仍保留这些日志，已有日志不会被删除或修改。

## New Log Defaults

点击“新建日志”时，默认日期和分类会结合当前浏览上下文预填：

- 如果已在日历中选中某一天，新日志日期默认使用该日期；未选中日期时使用当天日期。
- 如果当前筛选了父分类，新日志默认使用该父分类。
- 如果当前筛选到了二级分类，新日志会同时继承父分类与二级分类。
- 如果没有有效的分类筛选，则默认使用“其他”分类。

## Configuration

复制 `.env.example` 后，可按需配置：

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP 服务端口 | `3000` |
| `DATA_DIR` | JSON 数据与上传图片保存目录 | `./data` |
| `AUTH_TOKEN` | 可选的全站 API 访问 token；留空则不启用 | disabled |
| `DIARY_PASSWORD_HASH` | 可选的日记分类密码 SHA-256 哈希；留空则不启用 | disabled |

生成日记密码哈希的示例命令如下。请将 `your-password` 替换为自己的密码，并仅将生成的哈希保存在本地 `.env` 中：

```bash
node -e "const crypto=require('crypto'); console.log(crypto.createHash('sha256').update('your-password').digest('hex'))"
```

若启用 `AUTH_TOKEN`，访问页面时输入的访问密码就是该 token。请使用随机且足够长的值，不要提交真实配置文件。

## Data And Privacy

应用数据默认保存在 `data/`：

- `logs.json`：日志内容
- `todos.json`：待办事项
- `categories.json`：分类设置，父分类可包含 `calendar_day_visible` 日历按日可见性字段
- `private-uploads.json`：受保护图片记录
- `uploads/`：上传图片

`data/` 与 `.env` 已由 `.gitignore` 排除，不会随普通 Git 提交进入仓库。分享代码前仍建议使用 `git status` 检查暂存范围，避免提交个人内容或凭据。

## Backup And Restore

应用提供 JSON 数据备份与恢复能力。备份包含日志、待办、分类和私有上传标记；上传图片文件本身仍位于 `data/uploads/`，需要单独安全备份。

启用日记锁后，备份与恢复操作需要先解锁日记；启用全站访问 token 后，API 请求需要通过页面登录或携带对应授权信息。

## Development

```bash
npm run build
npm test
```

`npm run build` 仅将 CodeMirror 资源生成到未纳入版本控制的 `public/generated/editor/`。`npm test` 和 `npm start` 会自动执行该构建；若直接运行 `node server.js`，请先执行 `npm run build`。

后端由 Express 提供静态页面和 REST API，前端仍为原生 JavaScript 单页应用；CodeMirror 是唯一需要打包生成的浏览器资产。

## Relevant API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/logs?date=&month=&category=&search=&page=` | 查询日志；日期查询会应用分类日历显示设置 |
| `POST` | `/api/upload` | 上传日志图片，multipart 字段名为 `image` |
| `GET` | `/api/categories` | 获取分类树及日历显示设置 |
| `PATCH` | `/api/categories/:name/calendar-day-visibility` | 设置父分类按日历日期查看时是否显示，body 为 `{ "visible": boolean }` |
| `GET` | `/api/backup` | 导出 JSON 数据备份 |
| `POST` | `/api/restore` | 恢复 JSON 数据备份 |
