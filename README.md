# 留序 LiuXu

**让重要信息留下，让下一步行动有序。**

[![Windows 11 x64](https://img.shields.io/badge/Windows-11%20x64-2563eb?logo=windows11&logoColor=white)](https://github.com/ranr21094-AI/liuxu/releases/latest)
[![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple%20Silicon-111827?logo=apple&logoColor=white)](https://github.com/ranr21094-AI/liuxu/releases/latest)
[![Latest release](https://img.shields.io/github/v/release/ranr21094-AI/liuxu?display_name=tag&sort=semver)](https://github.com/ranr21094-AI/liuxu/releases/latest)
[![MIT License](https://img.shields.io/badge/license-MIT-2f332f)](LICENSE)

留序是一个本地优先的个人 AI 工作台，把 **Agent、知识库、长期记忆和待办** 放在同一个桌面应用里。你的数据库和附件保存在自己的电脑上；需要 AI 时，由你选择并配置模型服务商。

## 下载与安装

### Windows 11 x64

[**前往 GitHub Releases 下载最新安装包**](https://github.com/ranr21094-AI/liuxu/releases/latest)

1. 在最新版本页面下载 `LiuXu-Setup-1.2.2-x64.exe`。
2. 双击安装包，按向导选择程序安装位置。
3. 从桌面或开始菜单打开 **留序 LiuXu**。

安装包目前没有代码签名。Windows 可能显示“未知发布者”；请先核对 Release 页面提供的 SHA-256，再通过“更多信息 → 仍要运行”继续安装。

```powershell
Get-FileHash .\LiuXu-Setup-1.2.2-x64.exe -Algorithm SHA256
```

### macOS Apple Silicon（测试包）

当前 Mac 首发包支持 M 系列芯片和 macOS 12 及以上，构建产物为：

```text
LiuXu-1.2.2-mac-arm64.dmg
LiuXu-1.2.2-mac-arm64.zip
```

测试包使用 ad-hoc 签名，尚未经过 Apple 公证。将 DMG 中的 **留序 LiuXu** 拖到“应用程序”后，首次打开如被 Gatekeeper 拦截，请在“系统设置 → 隐私与安全性”中确认“仍要打开”。正式公开发布前会改用 Developer ID 签名并完成 Apple 公证。

可用随包提供的 `.sha256` 文件校验下载内容：

```bash
shasum -a 256 -c LiuXu-1.2.2-mac-arm64.dmg.sha256
shasum -a 256 -c LiuXu-1.2.2-mac-arm64.zip.sha256
```

![留序 LiuXu 工作台](docs/images/liuxu-overview.png)

## 你可以用留序做什么

| 区域 | 用途 |
| --- | --- |
| **Agent** | 与自己选择的模型协作，按确认权限检索知识、维护待办、联网搜索或执行本地工具。 |
| **知识库** | 编写 Markdown 笔记，导入 PDF、DOCX、TXT、Markdown 和图片，按知识库与文件夹整理，并使用双链与版本历史保护长期内容。 |
| **Memory** | 保存长期事实、习惯和流程；新记忆先以提案形式展示，经你确认后才写入。 |
| **待办** | 管理分类、优先级、重复任务、倒数日和可选的每日邮件提醒。 |

还包括私密知识锁定、Agent 会话归档、JSON/ZIP 备份恢复、模型级能力配置，以及可选的 Chrome 桥接和电脑工具。

### 知识双链与版本历史（v1.2.0）

知识库支持稳定 ID 双链。推荐写成 `[[显示标题|note:123]]` 或 `[[显示标题|file:4]]`；在编辑器输入 `[[` 会打开可搜索的本地文档选择器。直接输入 `[[标题]]` 时，保存会自动解析唯一匹配；重名或暂时找不到的标题会保留原文并在编辑器中提示，不会阻止保存。

链接只会跳转到留序自己的知识文档路由。目标重命名后链接仍然有效；归档目标会标记为归档，永久删除后显示断链。私密日记锁定时，选择器、反向引用和历史内容均不会泄露日记信息。

每篇文档底部都有默认折叠的“反向引用 / 版本历史”面板。正文、标题、标签、知识库、文件夹和文档日期发生变化时，留序会自动保存快照：5 分钟内合并，最多保留 50 个版本且最长 30 天。查看历史先显示元数据，选择版本后才加载正文；恢复旧版前会保存当前状态，并要求提交当前版本号，遇到并发编辑会拒绝覆盖。

完整 ZIP“替换恢复”会保留版本历史；旧版 JSON/ZIP 可继续恢复并自动重建双链。结构 JSON 和“合并恢复”只迁移当前内容，不迁移历史快照。

## 第一次使用

留序无需注册或登录。打开后可以直接记录笔记和待办；使用 Agent 前，请进入 **设置 → 模型**：

1. 新建一个模型供应商。
2. 填写服务地址、API 格式和你自己的 API Key。
3. 获取或手动添加模型，选择默认模型。

API Key 会使用本机密钥加密保存。调用模型、联网搜索或生图时，相应的提示词、你明确提供的材料或工具结果会发送给所选服务商；这些服务受各自隐私政策约束。

### 统一生图供应商（v1.2.0 补充更新）

进入 **设置 → 生图** 可以添加 Seedream 或 OpenAI Images 兼容供应商。每张供应商卡使用一个 API Key，并可添加任意模型 ID；模型可以分别声明参考图编辑、多图、尺寸、输出格式、透明背景、图层拆分、联网增强和流式输出能力。

正式生图仍通过 Agent 的 `image.generate` 发起并逐次确认。未指定模型时优先使用默认模型；默认模型能力不足时会选择配置顺序中的首个兼容模型，审批区会显示最终供应商和模型。连接测试不会生成图片；“试生图”会在费用提示后生成一张并显示在当前模型下方。

旧 Seedream/Getoken 设置会自动迁移。相同 Getoken Key 的模型合并到一张卡，不同 Key 自动拆卡；旧环境变量继续作为只读 fallback。公网自定义接口必须使用 HTTPS，HTTP 仅允许本机或私网，不支持任意 Header、自由请求模板或第三方代码。

### 应用内更新

桌面版进入 **设置 → 更新** 后会检查 GitHub Releases。发现新版本时，留序会下载当前平台的安装包并校验 GitHub SHA-256；确认后打开安装程序。更新只替换应用文件，不会覆盖知识、待办、密钥或备份数据。

更新包保存在应用专用缓存目录，成功升级或超过 7 天会自动清理。当前项目只发布 Windows 11 x64 和 macOS Apple Silicon 包；Mac 测试包或未签名 Windows 包会在打开前显示风险提示。`1.2.1` 用户可手动安装 `1.2.2`，之后继续使用应用内更新。

### Agent 通用文件附件（v1.2.2）

Agent 附件现支持图片、Markdown、JSON、文本/代码、PDF 和 DOCX。文件默认在本地解析后作为当前会话上下文发送，不会自动写入知识库；长资料建议先导入知识库再按需检索。输入区可选择或拖拽多个文件，图片仍支持粘贴和预览，PDF/DOCX 会标记解析状态，旧版 `.doc` 请先转换为 `.docx` 或 PDF。

供应商设置中的“文件传输”默认为本地解析；仅明确支持的 OpenAI Responses 或 Anthropic PDF 场景可选择原生文件传输。所有文件仍经过类型、大小、哈希和工作区权限校验。

## 数据与隐私

### 数据保存在哪里

Windows 安装版默认使用：

```text
%LOCALAPPDATA%\Work Log Data
```

这里的旧目录名为兼容现有版本而保留。主要内容包括：

| 内容 | 位置 |
| --- | --- |
| 知识、待办、Agent、设置 | `schedule.db` |
| 兼容认证数据库 | `users.db` |
| 笔记图片 | `uploads/` |
| 导入的知识附件 | `knowledge-files/` |
| Agent 生成的文件 | `agent-assets/` |
| 桌面启动日志 | `logs/desktop-main.log` |

模型密钥的本机主密钥单独保存在：

```text
%LOCALAPPDATA%\work-log\ai-secrets.key
```

macOS 安装版使用：

```text
~/Library/Application Support/work-log/data
```

桌面配置和 AI 密钥分别位于：

```text
~/Library/Application Support/work-log/desktop-config.json
~/Library/Application Support/work-log/ai-secrets.key
```

覆盖安装或卸载留序不会主动删除数据目录。正式清理电脑前，请先在 **设置 → 数据** 导出备份。

### 更换数据目录

应用内还没有数据目录选择器。请先完全退出留序，再编辑对应平台的桌面配置：

```text
%APPDATA%\work-log\desktop-config.json
~/Library/Application Support/work-log/desktop-config.json
```

例如：

```json
{
  "version": 1,
  "dataDir": "D:\\LiuXu Data"
}
```

如果原目录已经有数据，请先完整复制到新位置，再修改配置。也可以在启动前设置 `DATA_DIR` 环境变量；其优先级高于配置文件。

### 换一台电脑或跨平台迁移

同平台换机可以在正常退出后复制完整数据目录和 `ai-secrets.key`。Windows 与 macOS 之间不会自动搜索或迁移对方的数据目录；跨平台迁移请优先在 **设置 → 数据** 导出 ZIP 工作区，再在新电脑恢复。由于 ZIP 不包含本机主密钥，迁移后需要重新填写模型 API Key。

ZIP 工作区备份包含数据库和附件，但不会代替 `ai-secrets.key`。密钥文件应单独保管，不要上传到 GitHub 或网盘公开链接。

## 备份与恢复

在 **设置 → 数据** 中可以使用：

- **JSON 备份**：适合导出结构数据，不包含附件。
- **ZIP 工作区**：包含数据库、知识附件、上传图片和 Agent 文件，适合完整迁移。
- **合并恢复**：把备份内容并入当前工作区。
- **替换恢复**：验证通过后替换当前数据；写入前会保存恢复前副本。

恢复期间如果存在活动 Agent 任务，留序会拒绝操作，避免写入冲突。

## 常见问题

### 点击图标没有反应

留序采用单实例启动。再次点击会恢复并聚焦已有窗口。如果仍没有窗口：

1. 在任务管理器确认没有残留的 `LiuXu.exe` 或旧版 `Work Log.exe`。
2. 查看 `%LOCALAPPDATA%\Work Log Data\logs\desktop-main.log`。
3. 检查数据目录是否可写，以及 `.schedule.lock` 中记录的旧进程是否仍在运行。

### Windows 提示未知发布者

`v1.2.2` 测试安装包可能未完成正式签名，这是当前版本的已知限制。请从本仓库 Release 页面下载并核对 SHA-256，不要使用来源不明的转载包。

### macOS 提示无法验证开发者

当前 ad-hoc 测试包尚未经过 Apple 公证。请先核对 SHA-256，再到“系统设置 → 隐私与安全性”确认打开。Developer ID 签名、公证完成后的正式包不需要这一步。

### 卸载后数据还在

这是为了防止误删。确认已经备份且不再需要后，才手动删除 `%LOCALAPPDATA%\Work Log Data` 和本机密钥文件。

### Agent 显示未配置

进入 **设置 → 模型** 添加供应商、API Key 和至少一个模型。留序不内置公共模型额度。

## 开发与构建

### 环境要求

- Node.js `^22.12.0` 或 `>=24.0.0`
- Windows 11 x64，或 Apple Silicon Mac（macOS 12+）
- 从当前 C 盘项目构建时，脚本使用 `D:\Temp\work-log-build-c` 作为缓存并要求 D 盘至少 5 GB 可用空间

```bash
npm install
npm start
```

打开 `http://127.0.0.1:3000`。开发模式使用项目根目录的 `data/`。

常用命令：

```bash
npm run build          # 生成浏览器 vendor 资源
npm test               # 完整测试
npm run perf:baseline  # 在临时数据目录生成 1,000（可用 PERF_DOCS 调整）篇文档基线
npm run perf:check     # 运行基线并输出结构化性能检查结果
npm run desktop        # Electron 开发模式
npm run desktop:build  # 按当前系统生成 Windows 或 Mac 测试安装包
npm run desktop:build:win      # Windows NSIS x64
npm run desktop:build:win:cross # Apple Silicon Mac 交叉生成 Windows NSIS x64（有 Wine 时优先使用）
npm run desktop:build:mac      # Mac arm64 ad-hoc DMG + ZIP
npm run desktop:release:mac    # Mac Developer ID 签名 + Apple 公证
```

正式发布命令不会在缺少凭据时降级为测试包。运行前需要安装完整 Xcode、在钥匙串中导入 **Developer ID Application** 证书，并配置以下任一公证方式：

- App Store Connect API Key：`APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。
- Apple ID：`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。
- 钥匙串 profile：先执行 `xcrun notarytool store-credentials "liuxu-notary"`，构建时设置 `APPLE_KEYCHAIN_PROFILE=liuxu-notary`。

证书、密码和 API Key 只通过 macOS 钥匙串或环境变量提供，不写入仓库。正式流程会签名应用、公证并 staple 应用与 DMG，再执行 Gatekeeper、ticket、归档架构和 SHA-256 校验；任一步失败都不会生成“看似正式”的发布摘要。

构建产物位于 `dist/desktop/`：

```text
LiuXu-Setup-1.2.2-x64.exe
LiuXu-Setup-1.2.2-x64.exe.sha256
desktop-build-summary.json
LiuXu-1.2.2-mac-arm64.dmg
LiuXu-1.2.2-mac-arm64.dmg.sha256
LiuXu-1.2.2-mac-arm64.zip
LiuXu-1.2.2-mac-arm64.zip.sha256
desktop-build-summary-mac.json
```

安装包、个人数据库、附件、`.env` 和 `.zcode/` 不会进入 Git。

性能基线只使用临时 SQLite 数据库，不会读取或修改当前工作区数据。报告写入被 Git 忽略的 `perf-results/`，不包含正文、API Key 或本机数据路径；`PERF_STRICT=1 npm run perf:check` 可将目标阈值作为退出条件。

### 数据目录优先级

桌面安装版按以下顺序选择数据目录：

1. `DATA_DIR` 环境变量。
2. 平台桌面配置中保存的 `dataDir`。
3. Windows 使用 `%LOCALAPPDATA%\Work Log Data`；macOS 使用 `~/Library/Application Support/work-log/data`。

开发服务器默认使用 `./data`。可用 `PORT` 修改端口；默认只监听 `127.0.0.1`。如果把 `HOST` 改为 `0.0.0.0` 或其他非本机地址，服务本身没有账户访问控制，必须自行配置可信网络、HTTPS 和反向代理保护。

### 技术结构

- Electron 主进程启动本机随机端口的 Express 服务，并以沙箱窗口加载。
- SQLite 保存知识、待办、Agent、Memory 和设置，二进制附件保存在数据目录。
- 前端使用原生 JavaScript ES Modules，没有前端框架。
- Markdown 预览使用 marked、DOMPurify、KaTeX 和 PDF.js。
- `better-sqlite3` 原生模块随 Windows x64 或 macOS arm64 安装包分发。

### Chrome 桥接与电脑工具

`chrome-extension/` 是 Manifest V3 扩展，仅允许与 `127.0.0.1` / `localhost` 上的留序通信。电脑工具默认按本地白名单策略启用；写入、命令执行、联网和浏览器操作仍按工具风险请求确认，也可以在设置中关闭。

## 文档

- [更新日志](ChangeLog.md)
- [代码审查与修复记录](code-review-remediation.md)
- [v1.2.1 发布说明](docs/releases/v1.2.1.md)
- [v1.2.2 发布说明](docs/releases/v1.2.2.md)
- [v1.2.0 发布说明](docs/releases/v1.2.0.md)
- [v1.1.0 发布说明](docs/releases/v1.1.0.md)
- [贡献与仓库说明](AGENTS.md)

## 许可证

[MIT](LICENSE) © 2026 ranr21094-AI
