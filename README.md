# Work Log

一个本地优先的工作日志和待办应用，支持 Markdown/LaTeX 日志编辑、分类管理、统计、图片上传、数据备份恢复以及可选的访问保护和日记锁定。

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
- `categories.json`：分类设置
- `private-uploads.json`：受保护图片记录
- `uploads/`：上传图片

`data/` 与 `.env` 已由 `.gitignore` 排除，不会随普通 Git 提交进入仓库。分享代码前仍建议使用 `git status` 检查暂存范围，避免提交个人内容或凭据。

## Backup And Restore

应用提供 JSON 数据备份与恢复能力。备份包含日志、待办、分类和私有上传标记；上传图片文件本身仍位于 `data/uploads/`，需要单独安全备份。

启用日记锁后，备份与恢复操作需要先解锁日记；启用全站访问 token 后，API 请求需要通过页面登录或携带对应授权信息。

## Development

```bash
npm test
```

后端由 Express 提供静态页面和 REST API，前端为原生 JavaScript 单页应用，无额外构建步骤。
